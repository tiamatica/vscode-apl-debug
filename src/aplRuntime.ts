/*---------------------------------------------------------
 * Copyright (C) Tiamatica. All rights reserved.
 *--------------------------------------------------------*/

import { EventEmitter } from 'events';
import * as cp from 'child_process';
import * as Net from 'net';
import { Subject } from 'await-notify';

export interface FileAccessor {
	readFile(path: string): Promise<string>;
}

export interface IAplBreakpoint {
	id: number;
	line: number;
	verified: boolean;
}

interface IStepInTargets {
	id: number;
	label: string;
}

interface IStackFrame {
	index: number;
	name: string;
	file: string;
	line: number;
	column?: number;
}

interface IStack {
	count: number;
	frames: IStackFrame[];
}

/**
 * APL runtime with minimal debugger functionality.
 */
export class AplRuntime extends EventEmitter {

	// the initial file we are debugging
	private _sourceFile: string = '';
	public get sourceFile() {
		return this._sourceFile;
	}
	
	// the current interpreterStatus
	private _status?: InterpreterStatusMessage;
	public get status(): InterpreterStatusMessage | undefined {
		return this._status;
	}

	// maps from sourceFile to array of APL breakpoints
	private _breakPoints = new Map<string, IAplBreakpoint[]>();

	// since we want to send breakpoint events, we will assign an id to every event
	// so that the frontend can match events with breakpoints.
	private _breakpointId = 1;

	private _breakAddresses = new Set<string>();

	private _noDebug = false;
	private _trace = false;
	private _folder = '';

	private _client?: Net.Socket;

	private _exe = 'dyalog.exe';
	private _child?: cp.ChildProcess;

	private promptType = 0;
	private mq: Array<RideMessage> = []; // mq:message queue
	private blk = 0; // blk:blocked?
	private last = 0; // last:when last rundown finished
	private tid = 0; // tid:timeout id
	private _winId = 0; // current window id
	private _startTime = 0; // start time of debug session
	private _linkRE: RegExp; // start time of debug session
	private _sessionReady = new Subject();
	private _windows: OpenWindowMessage[] = [];

	private maxl = 1000;

	constructor(private _fileAccessor: FileAccessor) {
		super();
		this._startTime = Date.now();
		this._linkRE = new RegExp(`link${this._startTime}(\\[.*?\\])link${this._startTime}`, 'gs');
	}

	/**
	 * Start executing the given program.
	 */
	public async start(exe: string, program: string, folder: string, stopOnEntry: boolean, noDebug: boolean): Promise<void> {

		if (exe) {
			this._exe = exe;
		}
		this._noDebug = noDebug;
		this._sourceFile = program;
		this._folder = folder;
		this._trace = stopOnEntry;

		this.launchDyalog();
		await this._sessionReady.wait();

		if (this._folder) {
			this.exec(0, `⎕SE.Link.Create # '${this._folder}'`);
		}
		if (this._sourceFile) {
			this.exec(0, `name←⊃2 ⎕FIX 'file://${this._sourceFile}'`);
		}
		this.exec(0, `'link${this._startTime}'∘{⎕←⍺,⍺,⍨⎕JSON⍕¨⍵}¨5177⌶⍬`);
		if (this._sourceFile) {
			this.exec(this._trace ? 1 : 0, '⍎name');
		}

	}
	
	private _terminate: any;
	/**
	 * Stop debug session.
	 */
	public async terminate(): Promise<void> {
		return new Promise((resolve, reject) => {
			this._terminate = { resolve, reject };
			this.send('Exit', { code: 0 });
		});

	}

	private launchDyalog(): void {
		/* eslint-disable  @typescript-eslint/naming-convention */
		const env = {
			APLK0: 'default',
			AUTOCOMPLETE_PREFIXSIZE: '0',
			CLASSICMODE: '1',
			SINGLETRACE: '1',
			RIDE_SPAWNED: '1',
		};
		/* eslint-enable  @typescript-eslint/naming-convention */

		let srv = Net.createServer((y) => {
			this.log('spawned interpreter connected');
			srv && srv.close();
			this._client = y;
			this.initInterpreterConn();
		});
		srv.on('error', (e) => {
			this.err(e);
		});
		srv.listen(0, '127.0.0.1', () => {
			const adr = srv.address() as Net.AddressInfo;
			const hp = `${adr.address}:${adr.port}`;
			this.log(`listening for connections from spawned interpreter on ${hp}`);
			this.log(`spawning interpreter ${JSON.stringify(this._exe)}`);
			let args = ['+s', '-q', '-nokbd'];
			const stdio: cp.StdioOptions = ['pipe', 'ignore', 'ignore'];
			if (/^win/i.test(process.platform)) { args = []; stdio[0] = 'ignore'; }
			try {
				this._child = cp.spawn(this._exe, args, {
					stdio,
					detached: true,
					env: {
						...process.env,
						...env,
						RIDE_INIT: `CONNECT:${hp}`, // eslint-disable-line  @typescript-eslint/naming-convention 
					},
				});
			} catch (e) { this.err(e); return; }
			this._child.on('exit', (code, sig) => {
				srv && srv.close();
				if (code !== 0) {
					this.err(`Interpreter ${code !== null ? `exited with code ${code}` : `received ${sig}`}`);
				}
			});
			this._child.on('error', (y) => {
				srv && srv.close();
				this.err(y);
			});
		});
	}

	private err(e: Error | string): void {
		console.error(e);
	}

	private log(msg: String): void {
		console.log(msg);
	}


	private initInterpreterConn(): void {
		let b = Buffer.alloc(0x100000);
		let ib = 0; // ib:offset in b
		let nb = 0; // nb:length in b
		let old; // old:have we warned about an old interpreter?
		let handshakeDone = false;
		this._client?.on('data', (x) => {
			if (nb + x.length > b.length) {
				const r = Buffer.alloc(2 ** Math.ceil(Math.log(nb + x.length) / Math.log(2)));
				b.copy(r, 0, ib, ib + nb);
				ib = 0;
				b = r;
				this.log(`resized recv buffer to ${b.length}`);
			} else if (ib + nb + x.length > b.length) {
				b.copy(b, 0, ib, ib + nb);
				ib = 0;
			}
			x.copy(b, ib + nb, 0, x.length);
			nb += x.length;
			let n; // message length
			while (nb >= 4 && (n = b.readInt32BE(ib)) <= nb) {
				if (n <= 8) { this.err('Bad protocol message'); break; }
				const m = `${b.slice(ib + 8, ib + n)}`;
				ib += n;
				nb -= n;
				this.log(`recv ${this.trunc(m)}`);
				if (m[0] === '[') {
					const u = JSON.parse(m);
					this.recv(u[0], u[1]);
				} else if (m[0] === '<' && !old) {
					old = 1;
					this.err('This version of RIDE cannot talk to interpreters older than v15.0');
				} else if (/^UsingProtocol=/.test(m)) {
					if (m.slice(m.indexOf('=') + 1) === '2') {
						handshakeDone = true;
					} else {
						this.err('Unsupported RIDE protocol version');
						break;
					}
				}
			}
		});
		this._client?.on('error', (x) => {
			this._client && this.err(x);
		});
		this._client?.on('end', () => {
			if (handshakeDone) {
				this.log('interpreter disconnected');
				this.sendEvent('end');
			} else {
				this.err('Either no interpreter is listening on the specified port'
					+ ' or the interpreter is already serving another RIDE client.');
			}
		});
		this.sendEach([
			'SupportedProtocols=2', 'UsingProtocol=2',
			'["Identify",{"identity":1}]', '["Connect",{"remoteId":2}]', '["GetWindowLayout",{}]',
			'["Subscribe",{"status":["statusfields","stack","threads"]}]'
		]);
	}

	private rd() { // run down the queue
		while (this.mq.length && !this.blk) {
			const a = this.mq.shift(); // a[0]:command name, a[1]:command args
			if (a) {
				this.handleMessage(a);
			}
		}
		this.last = +new Date();
		this.tid = 0;
	}

	private handleMessage(rideMessage: RideMessage) {
		switch (rideMessage[0]) {
			case 'AppendSessionOutput': this.appendSessionOutput(rideMessage[1] as AppendSessionOutputMessage); break;
			case 'CloseWindow': this.closeWindow(rideMessage[1] as CloseWindowMessage); break;
			case 'Disconnect': this.disconnect(rideMessage[1] as DisconnectMessage); break;
			case 'EchoInput': this.echoInput(rideMessage[1] as EchoInputMessage); break;
			case 'GotoWindow': this.gotoWindow(rideMessage[1] as GotoWindowMessage); break;
			case 'HadError': this.hadError(rideMessage[1] as HadErrorMessage); break;
			case 'Identify': this.identify(rideMessage[1] as IdentifyMessage); break;
			case 'InternalError': this.internalError(rideMessage[1] as InternalErrorMessage); break;
			case 'InterpreterStatus': this.interpreterStatus(rideMessage[1] as InterpreterStatusMessage); break;
			case 'InvalidSyntax': this.invalidSyntax(); break;
			case 'NotificationMessage': this.notificationMessage(rideMessage[1] as NotificationMessage); break;
			case 'OpenWindow': this.openWindow(rideMessage[1] as OpenWindowMessage); break;
			case 'OptionsDialog': this.optionsDialog(rideMessage[1] as OptionsDialogMessage); break;
			case 'ReplyClearTraceStopMonitor': this.replyClearTraceStopMonitor(rideMessage[1] as ReplyClearTraceStopMonitorMessage); break;
			case 'ReplyFormatCode': this.replyFormatCode(rideMessage[1] as ReplyFormatCodeMessage); break;
			case 'ReplyGetAutocomplete': this.replyGetAutocomplete(rideMessage[1] as ReplyGetAutocompleteMessage); break;
			case 'ReplyGetConfiguration': this.replyGetConfiguration(rideMessage[1] as ReplyGetConfigurationMessage); break;
			case 'ReplyGetHelpInformation': this.replyGetHelpInformation(rideMessage[1] as ReplyGetHelpInformationMessage); break;
			case 'ReplyGetLanguageBar': this.replyGetLanguageBar(rideMessage[1] as ReplyGetLanguageBarMessage); break;
			case 'ReplyGetLog': this.replyGetLog(rideMessage[1] as ReplyGetLogMessage); break;
			case 'ReplyGetSIStack': this.replyGetSIStack(rideMessage[1] as ReplyGetSIStackMessage); break;
			case 'ReplyGetSyntaxInformation': this.replyGetSyntaxInformation(rideMessage[1] as ReplyGetSyntaxInformationMessage); break;
			case 'ReplyGetThreads': this.replyGetThreads(rideMessage[1] as ReplyGetThreadsMessage); break;
			case 'ReplySaveChanges': this.replySaveChanges(rideMessage[1] as ReplySaveChangesMessage); break;
			case 'ReplyTreeList': this.replyTreeList(rideMessage[1] as ReplyTreeListMessage); break;
			case 'ShowHTML': this.showHTML(rideMessage[1] as ShowHTMLMessage); break;
			case 'SetHighlightLine': this.setHighlightLine(rideMessage[1] as SetHighlightLineMessage); break;
			case 'SetPromptType': this.setPromptType(rideMessage[1] as SetPromptTypeMessage); break;
			case 'StatusOutput': this.statusOutput(rideMessage[1] as StatusOutputMessage); break;
			case 'StringDialog': this.stringDialog(rideMessage[1] as StringDialogMessage); break;
			case 'SysError': this.sysError(rideMessage[1] as SysErrorMessage); break;
			case 'TaskDialog': this.taskDialog(rideMessage[1] as TaskDialogMessage); break;
			case 'UnknownCommand': this.unknownCommand(rideMessage[1] as UnknownCommandMessage); break;
			case 'UpdateDisplayName': this.updateDisplayName(rideMessage[1] as UpdateDisplayNameMessage); break;
			case 'UpdateWindow': this.updateWindow(rideMessage[1] as OpenWindowMessage); break;
			case 'ValueTip': this.valueTip(rideMessage[1] as ValueTipMessage); break;
			case 'WindowTypeChanged': this.windowTypeChanged(rideMessage[1] as WindowTypeChangedMessage); break;
			default: this.send('UnknownCommand', { name: rideMessage[0] });
		}
	}

	private _linkInfo: string[][] = [];
	private add(text: string) {
		let m;
		let output = true;
		while (m = this._linkRE.exec(text)) {
			output = false;
			const json = m[1].replace(/\n\s+/, '');
			this._linkInfo.push(JSON.parse(json));
		}
		if (output) {
			this.sendEvent('output', text, this._sourceFile, 'stdout');
		}
	}

	private rrd() { // request rundown
		if (!this.tid) {
			if (Date.now() - this.last < 20) {
				this.tid = +setTimeout(() => { this.rd(); }, 20);
			} else {
				this.rd();
			}
		}
	}

	private recv(x: string, y) {
		this.mq.push([x, y]);
		this.rrd();
	}

	private trunc = (x: string) => (x.length > this.maxl ? `${x.slice(0, this.maxl - 3)}...` : x);
		
	private toBuf(x: string) {
		const b = Buffer.from(`xxxxRIDE${x}`);
		b.writeInt32BE(b.length, 0);
		return b;
	}


	private sendEach(x: Array<string>) {
		if (this._client) {
			x.forEach((y) => this.log(`send ${this.trunc(y)}`));
			this._client.write(Buffer.concat(x.map(this.toBuf)));
		}
	}

	private send(x: string, y: object) {
		if (this.promptType
			|| /Interrupt$|TreeList|Reply|FormatCode|GetAutocomplete|SaveChanges|CloseWindow|Exit/.test(x)) {
			this.sendEach([JSON.stringify([x, y])]);
		}
	}

	private exec(trace: number, expression: string) {
		this.send('Execute', { trace, text: `${expression}\n` });
	}

	private remoteIdentification?: object;
	private isClassic?: boolean;

	// RIDE protocol message handlers
	private appendSessionOutput(x: AppendSessionOutputMessage) {
		let s = x.result;
		const nq = Math.min(this.mq.length, 256);
		let i: number;
		for (i = 0; i < nq && this.mq[i][0] === 'AppendSessionOutput'; i++) {
			const r = (this.mq[i][1] as AppendSessionOutputMessage).result;
			s += r;
		}
		i && this.mq.splice(0, i);
		this.add(s);
	}

	private identify(x: IdentifyMessage) {
		this.remoteIdentification = x;
		this.isClassic = x.arch[0] === 'C';
	}

	private invalidSyntax() {
		this.err('Invalid syntax.');
	}

	private disconnect(x: DisconnectMessage) {
		if (this._terminate) {
			this._terminate.resolve(x.message);
		}
		this.err('Interpreter disconnected: ' + x.message);
		this.sendEvent('end');
	}

	private sysError(x: SysErrorMessage) {
		this.err('SysError: ' + x.text);
		this.sendEvent('end');
	}

	private internalError(x: InternalErrorMessage) {
		this.err(`An error (${x.error}) occurred processing ${x.message}`);
	}
	private notificationMessage(x: NotificationMessage) {
		// this.alert(x.message, 'Notification'); 
	}

	private updateDisplayName(x: UpdateDisplayNameMessage) {
		// this.wsid = x.displayName;
		// this.updTitle();
		// this.wse && this.wse.refresh();
	}

	private echoInput(x: EchoInputMessage) {
		// this.add(x.input);
	}

	private bannerDone = 0;

	private setPromptType(x: SetPromptTypeMessage) {
		const t = x.type;
		this.promptType = t;
		// if (t && ide.pending.length) D.send('Execute', { trace: 0, text: `${ide.pending.shift()}\n` });
		// else eachWin((w) => { w.prompt(t); });
		// (t === 2 || t === 4) && ide.wins[0].focus(); // ⎕ / ⍞ input
		// t === 1 && ide.getStats();
		if (t === 1 && this.bannerDone === 0) {
			this.bannerDone = 1;
			this._sessionReady.notify();
		}
	}

	private _hadError = 0;
	private hadError(x: HadErrorMessage) {
		this._hadError = x.error;
	}

	private gotoWindow(x: GotoWindowMessage) {
		this.sendEvent('openWindow', { filename: this._windows[x.win].filename });
	}

	private windowTypeChanged(x: WindowTypeChangedMessage) {
		// return ide.wins[x.win].setTC(x.tracer); 
	}
	private replyGetAutocomplete(x: ReplyGetAutocompleteMessage) {
		if (this._autocompletion) {
			this._autocompletion.resolve(x.options);
		}
	}
	private replyGetHelpInformation(x: ReplyGetHelpInformationMessage) {
		// if (x.url.length === 0) ide.getHelpExecutor.reject('No help found');
		// else ide.getHelpExecutor.resolve(x.url);
	}
	private replyGetLanguageBar(x: ReplyGetLanguageBarMessage) {
		// const { entries } = x;
		// D.lb.order = entries.map((k) => k.avchar || ' ').join('');
		// entries.forEach((k) => {
		// if (k.avchar) {
		// 	D.lb.tips[k.avchar] = [
		// 	`${k.name.slice(5)} (${k.avchar})`,
		// 	k.helptext.join('\n'),
		// 	];
		// 	D.sqglDesc[k.avchar] = `${k.name.slice(5)} (${k.avchar})`;
		// }
		// });
		// ide.lbarRecreate();
	}
	private replyGetSyntaxInformation(x: ReplyGetSyntaxInformationMessage) {
		// D.ParseSyntaxInformation(x);
		// D.ipc && D.ipc.server.broadcast('syntax', D.syntax);
	}
	private valueTip(x: ValueTipMessage) {
		this.log('getValueTip');
		if (this._valueTip[x.token]) {
			this._valueTip[x.token].resolve(x);
			delete this._valueTip[x.token];
		}
	}
	private setHighlightLine(x: SetHighlightLineMessage) {
		if (this._hadError === 1001) {
			this.sendEvent('stopOnBreakpoint');
			this._hadError = 0;
		// } else if (x.line === 0) {
		// 	this.sendEvent('stopOnEntry');
		} else {
			this.sendEvent('stopOnStep');
		}
	}
	private updateWindow(x: OpenWindowMessage) {
		this._windows[x.token] = x;
	}
	private replySaveChanges(x: ReplySaveChangesMessage) {
		// const w = ide.wins[x.win]; w && w.saved(x.err); 
	}
	private closeWindow(x: CloseWindowMessage) {
		delete this._windows[x.win];
	}
	private openWindow(x: OpenWindowMessage) {
		this._windows[x.token] = x;
		this._winId = x.token;
		this.sendEvent('openWindow', { filename: x.filename });
	}
	private showHTML(x: ShowHTMLMessage) {
		// if (D.el) {
		// let w = ide.w3500;
		// if (!w || w.isDestroyed()) {
		// 	ide.w3500 = new D.el.BrowserWindow({
		// 	width: 800,
		// 	height: 500,
		// 	webPreferences: {
		// 		contextIsolation: true,
		// 		nodeIntegration: false,
		// 	},
		// 	});
		// 	w = ide.w3500;
		// }
		// w.loadURL(`file://${__dirname}/empty.html`);
		// w.webContents.executeJavaScript(`document.body.innerHTML=${JSON.stringify(x.html)}`);
		// w.setTitle(x.title || '3500 I-beam');
		// } else {
		// const init = () => {
		// 	ide.w3500.document.body.innerHTML = x.html;
		// 	ide.w3500.document.getElementsByTagName('title')[0].innerHTML = D.util.esc(x.title || '3500⌶');
		// };
		// if (ide.w3500 && !ide.w3500.closed) {
		// 	ide.w3500.focus(); init();
		// } else {
		// 	ide.w3500 = window.open('empty.html', '3500 I-beam', 'width=800,height=500');
		// 	ide.w3500.onload = init;
		// }
		// }
	}
	private optionsDialog(x: OptionsDialogMessage) {
		// D.util.optionsDialog(x, (r) => {
		// D.send('ReplyOptionsDialog', { index: r, token: x.token });
		// });
	}
	private stringDialog(x: StringDialogMessage) {
		// D.util.stringDialog(x, (r) => {
		// D.send('ReplyStringDialog', { value: r, token: x.token });
		// });
	}
	private taskDialog(x: TaskDialogMessage) {
		this.sendEvent('taskDialog', x);
	}
	private replyClearTraceStopMonitor(x: ReplyClearTraceStopMonitorMessage) {
		// $.alert(`The following items were cleared:
		// ${x.traces} traces
		// ${x.stops} stops
		// ${x.monitors} monitors`, 'Clear all trace/stop/monitor');
	}
	private replyGetSIStack(x: ReplyGetSIStackMessage) {
		this.log('getSIStack');
		if (this._siStack) {
			const frames: IStackFrame[] = x.stack.map((s, i) => {
				const m = /(.*)\[(\d+)\]/.exec(s.description) || [];
				const link = this._linkInfo.find(x => `${x[1]}.${x[0]}` === m[1]) || [];
				const frame: IStackFrame = {
					index: i,
					name: m[1],
					file: link[3],
					line: +m[2],
				};
				return frame;
			});
			this._siStack.resolve({
				frames: frames,
				count: x.stack.length
			});
		}
	}
	private replyGetThreads(x: ReplyGetThreadsMessage) {
		// const l = x.threads.length;
		// I.sb_threads.innerText = `&: ${l}`;
		// I.sb_threads.classList.toggle('active', l > 1);
		// ide.dbg && ide.dbg.threads.render(x.threads);
	}
	private interpreterStatus(x: InterpreterStatusMessage) {
		this._status = x;
		// // update status bar fields here
		// I.sb_ml.innerText = `⎕ML: ${x.ML}`;
		// I.sb_io.innerText = `⎕IO: ${x.IO}`;
		// I.sb_sis.innerText = `⎕SI: ${x.SI}`;
		// // I.sb_trap.innerText = `⎕TRAP: ${x.TRAP}`; // TRAP doesn't display a value
		// I.sb_dq.innerText = `⎕DQ: ${x.DQ}`;
		// I.sb_threads.innerText = `&: ${x.NumThreads}`;
		// I.sb_cc.innerText = `CC: ${x.CompactCount}`;
		// I.sb_gc.innerText = `GC: ${x.GarbageCount}`;
		// // Eventually we would like to read the default values from the interpreter.
		// I.sb_ml.classList.toggle('active', x.ML !== 1);
		// I.sb_io.classList.toggle('active', x.IO !== 1);
		// I.sb_sis.classList.toggle('active', x.SI > 0);
		// I.sb_trap.classList.toggle('active', x.TRAP !== 0);
		// I.sb_dq.classList.toggle('active', x.DQ !== 0);
		// I.sb_threads.classList.toggle('active', x.NumThreads > 1);
	}
	private replyFormatCode(x: ReplyFormatCodeMessage) {
		// const w = D.wins[x.win];
		// w.ReplyFormatCode(x.text);
		// ide.hadErr > 0 && (ide.hadErr -= 1);
		// ide.focusWin(w);
	}
	private replyGetConfiguration(x: ReplyGetConfigurationMessage) {
		// x.configurations.forEach((c) => {
		// 	if (c.name === 'AUTO_PAUSE_THREADS') D.prf.pauseOnError(c.value === '1');
		// });
	}
	private replyTreeList(x: ReplyTreeListMessage) {
		if (this._treelist[x.nodeId]) {
			this._treelist[x.nodeId].resolve(x);
			delete this._treelist[x.nodeId];
		}
	}
	private statusOutput(x: StatusOutputMessage) {
		let s = x.text;
		const nq = Math.min(this.mq.length, 256);
		let i: number;
		for (i = 0; i < nq && this.mq[i][0] === 'StatusOutput'; i++) {
			const r = (this.mq[i][1] as StatusOutputMessage).text;
			s += r;
		}
		i && this.mq.splice(0, i);
		this.sendEvent('output', s, undefined, 'stderr');
	}
	private replyGetLog(x: ReplyGetLogMessage) {
		this.add(x.result.join('\n'));
	}
	private unknownCommand(x: UnknownCommandMessage) {
	}

	/**
	 * Execute expression
	 */
	public execute(expr: string) {
		this.exec(0, expr);
	}

	private _autocompletion: any;
	/**
	 * Get autocomplete
	 */
	public getAutocomplete(line: string, pos: number, token: number): PromiseLike<string[]> {
		return new Promise((resolve, reject) => {
			this._autocompletion = { resolve, reject };
			this.send('GetAutocomplete', { line, pos, token });
		});
	}

	private _siStack: any;
	/**
	 * Get stack
	 */
	public getSIStack(): PromiseLike<IStack> {
		return new Promise((resolve, reject) => {
			this._siStack = { resolve, reject };
			this.send('GetSIStack', {});
		});
	}

	private _valueTip = {};
	/**
	 * Get Value Tip
	 */
	public getValueTip(line: string, pos: number, token: number, win: number = 0): PromiseLike<ValueTipMessage> {
		return new Promise((resolve, reject) => {
			this._valueTip[token] = { resolve, reject };
			this.send('GetValueTip', { // ask interpreter
				win,
				token,
				line,
				pos,
				maxWidth: 200,
				maxHeight: 100,
			  });
		});
	}

	private _treelist = {};
	/**
	 * Get autocomplete
	 */
	public getTreeList(nodeId: number): PromiseLike<ReplyTreeListMessage> {
		return new Promise((resolve, reject) => {
			this._treelist[nodeId] = { resolve, reject };
			this.send('TreeList', { nodeId });
		});
	}


	/**
	 * Reply to TaskDialog
	 */
	public replyTaskDialog(index: number, token: number) {
		this.send('ReplyTaskDialog', { index, token });
	}

	/**
	 * Continue execution to the end/beginning.
	 */
	public continue(reverse = false) {
		this.run(reverse, undefined);
	}

	/**
	 * Step to the next/previous non empty line.
	 */
	public step(reverse = false, event = 'stopOnStep') {
		this.run(reverse, event);
	}

	/**
	 * Step into
	 */
	public stepIn(targetId: number | undefined) {
		this.send('StepInto', { win: this._winId });
		this.sendEvent('stopOnStep');

	}

	/**
	 * "Step out" for APL debug means: go to previous character
	 */
	public stepOut() {
		this.sendEvent('stopOnStep');
	}

	public getStepInTargets(frameId: number): IStepInTargets[] {
		return [];
	}

	public getBreakpoints(path: string, line: number): number[] {

		return [];
	}

	/*
	 * Set breakpoint in file with given line.
	 */
	public async setBreakPoint(path: string, line: number): Promise<IAplBreakpoint> {

		const bp: IAplBreakpoint = { verified: false, line, id: this._breakpointId++ };
		let bps = this._breakPoints.get(path);
		if (!bps) {
			bps = new Array<IAplBreakpoint>();
			this._breakPoints.set(path, bps);
		}
		bps.push(bp);
		this.send('SetLineAttributes', { win: this._winId, stop: bps.map(bp => bp.line) });
		await this.verifyBreakpoints(path);

		return bp;
	}

	/*
	 * Clear breakpoint in file with given line.
	 */
	public clearBreakPoint(path: string, line: number): IAplBreakpoint | undefined {
		const bps = this._breakPoints.get(path);
		if (bps) {
			const index = bps.findIndex(bp => bp.line === line);
			if (index >= 0) {
				const bp = bps[index];
				bps.splice(index, 1);
				return bp;
			}
		}
		return undefined;
	}

	/*
	 * Clear all breakpoints for file.
	 */
	public clearBreakpoints(path: string): void {
		this._breakPoints.delete(path);
	}

	/*
	 * Clear all data breakpoints.
	 */
	public clearAllDataBreakpoints(): void {
		this._breakAddresses.clear();
	}

	// private methods

	/**
	 * Run through the file.
	 * If stepEvent is specified only run a single step and emit the stepEvent.
	 */
	private run(reverse = false, stepEvent?: string) {
		if (reverse) {
			this.send('TraceBackward', { win: this._winId });
		} else {
			if (stepEvent) {
				this.send('RunCurrentLine', { win: this._winId });
			} else {
				this.send('Continue', { win: this._winId });
			}
			// no more lines: run to end
			// this.sendEvent('end');
		}
	}

	private async verifyBreakpoints(path: string): Promise<void> {

		if (this._noDebug) {
			return;
		}

		const bps = this._breakPoints.get(path);
		if (bps) {
			bps.forEach(bp => {
				if (!bp.verified) {
					bp.verified = true;
					this.sendEvent('breakpointValidated', bp);				
				}
			});
		}
	}

	private sendEvent(event: string, ...args: any[]) {
		setImmediate(_ => {
			this.emit(event, ...args);
		});
	}
}