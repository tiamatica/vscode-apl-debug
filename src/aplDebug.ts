/*---------------------------------------------------------
 * Copyright (C) Tiamatica. All rights reserved.
 *--------------------------------------------------------*/

import {
	Logger, logger,
	LoggingDebugSession,
	InitializedEvent, TerminatedEvent, StoppedEvent, BreakpointEvent, OutputEvent,
	// ProgressStartEvent, ProgressUpdateEvent, ProgressEndEvent, 
	InvalidatedEvent,
	Thread, StackFrame, Scope, Source, Handles, Breakpoint
} from 'vscode-debugadapter';
import * as vscode from 'vscode';
import { DebugProtocol } from 'vscode-debugprotocol';
import { basename } from 'path';
import { AplRuntime, IAplBreakpoint, FileAccessor } from './aplRuntime';
import { Subject } from 'await-notify';

// function timeout(ms: number) {
// 	return new Promise(resolve => setTimeout(resolve, ms));
// }

/**
 * This interface describes the apl-debug specific launch attributes
 * (which are not part of the Debug Adapter Protocol).
 * The schema for these attributes lives in the package.json of the apl-debug extension.
 * The interface should always match this schema.
 */
interface ILaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	/** An absolute path to the "program" to debug. */
	program: string;
	/** Path to the dyalog executable to use for the debug session. */
	exe: string;
	/** An absolute path to the folder to load into debugger. */
	cwd: string;
	/** Automatically stop target after launch. If not specified, target does not stop. */
	stopOnEntry?: boolean;
	/** enable logging the Debug Adapter Protocol */
	trace?: boolean;
	/** run without debugging */
	noDebug?: boolean;
}

export class AplDebugSession extends LoggingDebugSession {

	// we don't support multiple threads, so we can use a hardcoded ID for the default thread
	private static threadID = 1;

	// an APL runtime (or debugger)
	private _runtime: AplRuntime;

	private _variableHandles = new Handles<string>();

	private _configurationDone = new Subject();

	private _cancelationTokens = new Map<number, boolean>();

	private _showHex = false;
	private _useInvalidatedEvent = false;

	/**
	 * Creates a new debug adapter that is used for one debug session.
	 * We configure the default implementation of a debug adapter here.
	 */
	public constructor(fileAccessor: FileAccessor) {
		super("apl-debug.txt");

		// this debugger uses zero-based lines and columns
		this.setDebuggerLinesStartAt1(false);
		this.setDebuggerColumnsStartAt1(false);

		this._runtime = new AplRuntime(fileAccessor);

		// setup event handlers
		this._runtime.on('taskDialog', (opt) => {
			vscode.window.showQuickPick(opt.buttonText, { title: opt.text }).then(
				(selected) =>{
					const index = opt.buttonText.indexOf(selected);
					this._runtime.replyTaskDialog(index  < 0 ? -1 : 100 + index, opt.token);
				},
				(error) => {
					this._runtime.replyTaskDialog(-1, opt.token);
				}
			);
		});
		this._runtime.on('openWindow', (opt) => {
			vscode.window.showTextDocument(vscode.Uri.file(opt.filename));
		});
		
		this._runtime.on('stopOnEntry', () => {
			this.sendEvent(new StoppedEvent('entry', AplDebugSession.threadID));
		});
		this._runtime.on('stopOnStep', () => {
			this.sendEvent(new StoppedEvent('step', AplDebugSession.threadID));
		});
		this._runtime.on('stopOnBreakpoint', () => {
			this.sendEvent(new StoppedEvent('breakpoint', AplDebugSession.threadID));
		});
		this._runtime.on('stopOnDataBreakpoint', () => {
			this.sendEvent(new StoppedEvent('data breakpoint', AplDebugSession.threadID));
		});
		this._runtime.on('stopOnException', (exception) => {
			if (exception) {
				this.sendEvent(new StoppedEvent(`exception(${exception})`, AplDebugSession.threadID));
			} else {
				this.sendEvent(new StoppedEvent('exception', AplDebugSession.threadID));
			}
		});
		this._runtime.on('breakpointValidated', (bp: IAplBreakpoint) => {
			this.sendEvent(new BreakpointEvent('changed', { verified: bp.verified, id: bp.id } as DebugProtocol.Breakpoint));
		});
		this._runtime.on('output', (text, filePath, category) => {
			const e: DebugProtocol.OutputEvent = new OutputEvent(text, category);
			e.body.source = this.createSource(filePath);
			this.sendEvent(e);
		});
		this._runtime.on('end', () => {
			this.sendEvent(new TerminatedEvent());
		});
	}

	/**
	 * The 'initialize' request is the first request called by the frontend
	 * to interrogate the features the debug adapter provides.
	 */
	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {

		if (args.supportsProgressReporting) {
			// this._reportProgress = true;
		}
		if (args.supportsInvalidatedEvent) {
			this._useInvalidatedEvent = true;
		}

		// build and return the capabilities of this debug adapter:
		response.body = response.body || {};

		// the adapter implements the configurationDoneRequest.
		response.body.supportsConfigurationDoneRequest = true;

		// make VS Code use 'evaluate' when hovering over source
		response.body.supportsEvaluateForHovers = true;

		// make VS Code show a 'step back' button
		response.body.supportsStepBack = true;

		// make VS Code support data breakpoints
		response.body.supportsDataBreakpoints = true;

		// make VS Code support completion in REPL
		response.body.supportsCompletionsRequest = true;
		response.body.completionTriggerCharacters = [ ".", "[" ];

		// make VS Code send cancelRequests
		response.body.supportsCancelRequest = true;

		// make VS Code send the breakpointLocations request
		response.body.supportsBreakpointLocationsRequest = true;

		// make VS Code provide "Step in Target" functionality
		response.body.supportsStepInTargetsRequest = true;

		// make VS Code send exceptionInfoRequests
		response.body.supportsExceptionInfoRequest = true;

		this.sendResponse(response);

		// since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
		// we request them early by sending an 'initializeRequest' to the frontend.
		// The frontend will end the configuration sequence by calling 'configurationDone' request.
		this.sendEvent(new InitializedEvent());
	}

	/**
	 * Called at the end of the configuration sequence.
	 * Indicates that all breakpoints etc. have been sent to the DA and that the 'launch' can start.
	 */
	protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
		super.configurationDoneRequest(response, args);

		// notify the launchRequest that configuration has finished
		this._configurationDone.notify();
	}

	protected async launchRequest(response: DebugProtocol.LaunchResponse, args: ILaunchRequestArguments) {

		// make sure to 'Stop' the buffered logging if 'trace' is not set
		logger.setup(args.trace ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop, false);

		// wait until configuration has finished (and configurationDoneRequest has been called)
		await this._configurationDone.wait(1000);

		// start the program in the runtime
		await this._runtime.start(args.exe, args.program, args.cwd, !!args.stopOnEntry, !!args.noDebug);

		this.sendResponse(response);
	}
	protected async disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments, request?: DebugProtocol.Request) {
		await this._runtime.terminate();
		this.sendResponse(response);
	}
    
	protected async terminateRequest(response: DebugProtocol.TerminateResponse, args: DebugProtocol.TerminateArguments, request?: DebugProtocol.Request) {
		await this._runtime.terminate();
		this.sendResponse(response);
	}

	protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): Promise<void> {

		const path = args.source.path as string;
		const clientLines = args.lines || [];

		// clear all breakpoints for this file
		this._runtime.clearBreakpoints(path);

		// set and verify breakpoint locations
		const actualBreakpoints0 = clientLines.map(async l => {
			const { verified, line, id } = await this._runtime.setBreakPoint(path, this.convertClientLineToDebugger(l));
			const bp = new Breakpoint(verified, this.convertDebuggerLineToClient(line)) as DebugProtocol.Breakpoint;
			bp.id= id;
			return bp;
		});
		const actualBreakpoints = await Promise.all<DebugProtocol.Breakpoint>(actualBreakpoints0);

		// send back the actual breakpoint positions
		response.body = {
			breakpoints: actualBreakpoints
		};
		this.sendResponse(response);
	}

	protected breakpointLocationsRequest(response: DebugProtocol.BreakpointLocationsResponse, args: DebugProtocol.BreakpointLocationsArguments, request?: DebugProtocol.Request): void {

		if (args.source.path) {
			const bps = this._runtime.getBreakpoints(args.source.path, this.convertClientLineToDebugger(args.line));
			response.body = {
				breakpoints: bps.map(col => {
					return {
						line: args.line,
						column: this.convertDebuggerColumnToClient(col)
					};
				})
			};
		} else {
			response.body = {
				breakpoints: []
			};
		}
		this.sendResponse(response);
	}

	protected exceptionInfoRequest(response: DebugProtocol.ExceptionInfoResponse, args: DebugProtocol.ExceptionInfoArguments) {
		response.body = {
			exceptionId: 'Exception ID',
			description: 'This is a descriptive description of the exception.',
			breakMode: 'always',
			details: {
				message: 'Message contained in the exception.',
				typeName: 'Short type name of the exception object',
				stackTrace: 'stack frame 1\nstack frame 2',
			}
		};
		this.sendResponse(response);
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {

		// runtime supports no threads so just return a default thread.
		response.body = {
			threads: [
				new Thread(AplDebugSession.threadID, "thread 1")
			]
		};
		this.sendResponse(response);
	}

	protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {
		this._runtime.getSIStack()
		.then((stk) => {
			response.body = {
				stackFrames: stk.frames.map(f => {
					return new StackFrame(
						f.index, 
						f.name, 
						this.createSource(f.file), 
						this.convertDebuggerLineToClient(f.line)
					);
				}),
				totalFrames: stk.count,
			};
			this.sendResponse(response);	
		});
	}

	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {

		response.body = {
			scopes: [
				new Scope("Global", this._variableHandles.create("global"), false),
				new Scope("Status", this._variableHandles.create("status"), false)
			]
		};
		this.sendResponse(response);
	}

	private classMap(nc: number): string {
		switch(nc) {
			case 2.1:
			case 2.2:
			case 2.6:
			return 'data'; break;
			
			case 2.3:
			return 'property'; break;

			case 3.1:
			case 3.2:
			case 3.3:
			case 3.6:
			case 4.1:
			case 4.2:
			case 4.3:
			return 'method'; break;

			case -1: 
			case 9.1:
			case 9.2:
			case 9.4:
			case 9.6:
			return 'class'; break;

			case 9.5:
			case 9.7:
			return 'interface'; break;

			default: return 'virtual';
		}
	}

	private _varMap = {};

	protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request) {

		const a = args;
		const parent = this._variableHandles.get(args.variablesReference);
		let variables: DebugProtocol.Variable[];
		if (parent === 'status') {
			await new Promise(f => setTimeout(f, 10)); // give runtime a chance to process a fresh status update
			const status = this._runtime.status;
			if (!status) {
				return response;
			}
			variables = Object.keys(status).map((name) =>{
				const kind = 'data';
				return { 
					name, 
					value: `${status[name]}`,
					type: kind,
					presentationHint: { kind },
					variablesReference: 0
				} as DebugProtocol.Variable;
			});

		} else {
			const parentNodeId = this._varMap[args.variablesReference] || 0;
			const treenode = await this._runtime.getTreeList(parentNodeId);
			variables = treenode.names.map((name, index) => {
				const kind = this.classMap(treenode.classes[index]);
				const evaluateName = parentNodeId === 0 ? name : `${parent}.${name}`;
				const debugVar = { 
					name, 
					value:'',
					evaluateName,
					type: kind,
					presentationHint: { kind },
					variablesReference: 0
				} as DebugProtocol.Variable;
				const nodeId = treenode.nodeIds[index];
				if (nodeId !== 0) {
					const varHandle = Object.keys(this._varMap).find((k) => this._varMap[k] === nodeId);
					if (varHandle) {
						debugVar.variablesReference = +varHandle;
					} else {
						debugVar.variablesReference = this._variableHandles.create(evaluateName);
						this._varMap[debugVar.variablesReference] = nodeId;
					}
				}
				return debugVar;
			});
		}	
		response.body = {
			variables: variables
		};
		this.sendResponse(response);
	}

	protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
		this._runtime.continue();
		this.sendResponse(response);
	}

	protected reverseContinueRequest(response: DebugProtocol.ReverseContinueResponse, args: DebugProtocol.ReverseContinueArguments): void {
		this._runtime.continue(true);
		this.sendResponse(response);
 	}

	protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
		this._runtime.step();
		this.sendResponse(response);
	}

	protected stepBackRequest(response: DebugProtocol.StepBackResponse, args: DebugProtocol.StepBackArguments): void {
		this._runtime.step(true);
		this.sendResponse(response);
	}

	protected stepInTargetsRequest(response: DebugProtocol.StepInTargetsResponse, args: DebugProtocol.StepInTargetsArguments) {
		const targets = this._runtime.getStepInTargets(args.frameId);
		response.body = {
			targets: targets.map(t => {
				return { id: t.id, label: t.label };
			})
		};
		this.sendResponse(response);
	}

	protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
		this._runtime.stepIn(args.targetId);
		this.sendResponse(response);
	}

	protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {
		this._runtime.stepOut();
		this.sendResponse(response);
	}

	protected async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): Promise<void> {

		// let reply: string | undefined = undefined;

		if (args.context === 'repl') {
			this._runtime.execute(args.expression);
		}

		response.body = {
			result: '',
			variablesReference: 0
		};
		this.sendResponse(response);
	}

	protected completionsRequest(response: DebugProtocol.CompletionsResponse, args: DebugProtocol.CompletionsArguments): void {

		this._runtime.getAutocomplete(args.text, args.column - 1, 0)
		.then((items) => {
			response.body = {
				targets: items.map(label => ({ label }))
			};
			this.sendResponse(response);	
		});
	}

	protected cancelRequest(response: DebugProtocol.CancelResponse, args: DebugProtocol.CancelArguments) {
		if (args.requestId) {
			this._cancelationTokens.set(args.requestId, true);
		}
		if (args.progressId) {
			// this._cancelledProgressId= args.progressId;
		}
	}

	protected customRequest(command: string, response: DebugProtocol.Response, args: any) {
		if (command === 'toggleFormatting') {
			this._showHex = ! this._showHex;
			if (this._useInvalidatedEvent) {
				this.sendEvent(new InvalidatedEvent( ['variables'] ));
			}
			this.sendResponse(response);
		} else {
			super.customRequest(command, response, args);
		}
	}

	//---- helpers

	private createSource(filePath: string): Source {
		return new Source(basename(filePath), this.convertDebuggerPathToClient(filePath), undefined, undefined, 'apl-adapter-data');
	}
}
