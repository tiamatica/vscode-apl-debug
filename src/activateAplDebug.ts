/*---------------------------------------------------------
 * Copyright (C) Tiamatica. All rights reserved.
 *--------------------------------------------------------*/

'use strict';

import * as vscode from 'vscode';
import { WorkspaceFolder, DebugConfiguration, ProviderResult, CancellationToken } from 'vscode';
import { AplDebugSession } from './aplDebug';
import { FileAccessor } from './aplRuntime';

let aplStatusBarItem: vscode.StatusBarItem;

export function activateAplDebug(context: vscode.ExtensionContext, factory?: vscode.DebugAdapterDescriptorFactory) {

	// create a new status bar item that we can now manage
	aplStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	aplStatusBarItem.show();
	// aplStatusBarItem.command = myCommandId;
	
	context.subscriptions.push(
		aplStatusBarItem,
		vscode.commands.registerCommand('extension.apl-debug.runEditorContents', (resource: vscode.Uri) => {
			let targetResource = resource;
			if (!targetResource && vscode.window.activeTextEditor) {
				targetResource = vscode.window.activeTextEditor.document.uri;
			}
			if (targetResource) {
				vscode.debug.startDebugging(undefined, {
						type: 'apl',
						name: 'Run File',
						request: 'launch',
						program: targetResource.fsPath
					},
					{ noDebug: true }
				);
			}
		}),
		vscode.commands.registerCommand('extension.apl-debug.debugEditorContents', (resource: vscode.Uri) => {
			let targetResource = resource;
			if (!targetResource && vscode.window.activeTextEditor) {
				targetResource = vscode.window.activeTextEditor.document.uri;
			}
			if (targetResource) {
				vscode.debug.startDebugging(undefined, {
					type: 'apl',
					name: 'Debug File',
					request: 'launch',
					program: targetResource.fsPath,
					stopOnEntry: true
				});
			}
		}),
		vscode.commands.registerTextEditorCommand('extension.apl-debug.help', (resource: vscode.TextEditor) => {
			let targetResource = resource;
			if (!targetResource && vscode.window.activeTextEditor) {
				targetResource = vscode.window.activeTextEditor;
			}
			const { document, selection } = targetResource;
			const textline = document.lineAt(selection.active.line);
			if (textline) {
				const ds = vscode.debug.activeDebugSession;
				if (ds) {
					ds.customRequest('help', { line: textline.text, pos: selection.active.character });
				}
			}
		}),
		vscode.commands.registerCommand('extension.apl-debug.toggleFormatting', (variable) => {
			const ds = vscode.debug.activeDebugSession;
			if (ds) {
				ds.customRequest('toggleFormatting');
			}
		}),
		vscode.commands.registerCommand('extension.apl-debug.traceBackward', (variable) => {
			const ds = vscode.debug.activeDebugSession;
			if (ds) {
				ds.customRequest('traceBackward');
			}
		}),
		vscode.commands.registerCommand('extension.apl-debug.traceForward', (variable) => {
			const ds = vscode.debug.activeDebugSession;
			if (ds) {
				ds.customRequest('traceForward');
			}
		}),
		vscode.commands.registerCommand('extension.apl-debug.cutback', (variable) => {
			const ds = vscode.debug.activeDebugSession;
			if (ds) {
				ds.customRequest('cutback');
			}
		})
	);

	context.subscriptions.push(vscode.commands.registerCommand('extension.apl-debug.getProgramName', config => {
		return vscode.window.showInputBox({
			placeHolder: "Please enter the name of an APL file in the workspace folder",
			value: "foo.aplf"
		});
	}));

	// register a configuration provider for 'apl' debug type
	const provider = new AplConfigurationProvider();
	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('apl', provider));

	// register a dynamic configuration provider for 'apl' debug type
	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('apl', {
		provideDebugConfigurations(folder: WorkspaceFolder | undefined): ProviderResult<DebugConfiguration[]> {
			return [
				{
					name: "Dynamic Launch",
					request: "launch",
					type: "apl",
					program: "${file}"
				},
				{
					name: "Another Dynamic Launch",
					request: "launch",
					type: "apl",
					program: "${file}"
				},
				{
					name: "APL Launch",
					request: "launch",
					type: "apl",
					program: "${file}"
				}
			];
		}
	}, vscode.DebugConfigurationProviderTriggerKind.Dynamic));

	if (!factory) {
		factory = new InlineDebugAdapterFactory();
	}
	context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('apl', factory));
	if ('dispose' in factory) {
		// @ts-ignore
		context.subscriptions.push(factory);
	}
	context.subscriptions.push(vscode.debug.onDidReceiveDebugSessionCustomEvent((customEvent) => {
		if (customEvent.event === 'statusInformation') {
			aplStatusBarItem.text = customEvent.body.text;
		}
	}));

	// override VS Code's default implementation of the debug hover
	context.subscriptions.push(vscode.languages.registerEvaluatableExpressionProvider('apl', {
		provideEvaluatableExpression(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.EvaluatableExpression> {
			const wordRange = document.getWordRangeAtPosition(position);
			return wordRange ? new vscode.EvaluatableExpression(wordRange) : undefined;
		}
	}));

	// override VS Code's default implementation of the "inline values" feature"
	context.subscriptions.push(vscode.languages.registerInlineValuesProvider('apl', {

		provideInlineValues(document: vscode.TextDocument, viewport: vscode.Range, context: vscode.InlineValueContext) : vscode.ProviderResult<vscode.InlineValue[]> {

			const allValues: vscode.InlineValue[] = [];

			for (let l = viewport.start.line; l <= context.stoppedLocation.end.line; l++) {
				const line = document.lineAt(l);
				var regExp = /local_[ifso]/ig;	// match variables of the form local_i, local_f, Local_i, LOCAL_S...
				do {
					var m = regExp.exec(line.text);
					if (m) {
						const varName = m[0];
						const varRange = new vscode.Range(l, m.index, l, m.index + varName.length);

						// some literal text
						//allValues.push(new vscode.InlineValueText(varRange, `${varName}: ${viewport.start.line}`));

						// value found via variable lookup
						allValues.push(new vscode.InlineValueVariableLookup(varRange, varName, false));

						// value determined via expression evaluation
						//allValues.push(new vscode.InlineValueEvaluatableExpression(varRange, varName));
					}
				} while (m);
			}

			return allValues;
		}
	}));
}

class AplConfigurationProvider implements vscode.DebugConfigurationProvider {

	/**
	 * Massage a debug configuration just before a debug session is being launched,
	 * e.g. add all missing attributes to the debug configuration.
	 */
	resolveDebugConfiguration(folder: WorkspaceFolder | undefined, config: DebugConfiguration, token?: CancellationToken): ProviderResult<DebugConfiguration> {

		// if launch.json is missing or empty
		if (!config.type && !config.request && !config.name) {
			const editor = vscode.window.activeTextEditor;
			if (editor && editor.document.languageId === 'apl') {
				config.type = 'apl';
				config.name = 'Launch';
				config.request = 'launch';
				config.program = '${file}';
				config.cwd = folder;
				config.stopOnEntry = true;
			}
		}

		if (!config.program && !config.cwd) {
			return vscode.window.showInformationMessage("Cannot find a program to debug").then(_ => {
				return undefined;	// abort launch
			});
		}

		return config;
	}
}

export const workspaceFileAccessor: FileAccessor = {
	isWindows: false,
	async checkExists(filePath: string, timeout: number) {
		return new Promise(function (resolve, reject) {
			const startTS = +new Date();
			const interval = Math.min(timeout, 100);
			let stats: vscode.FileStat;
			const uri = pathToUri(filePath);
			const check = async () => {
				if (timeout < +new Date() - startTS) {
					reject(new Error('File did not exists and was not created during the timeout.'));
				}
				try {
					stats = await vscode.workspace.fs.stat(uri);
					clearTimeout(timer);
					resolve(true);
				} catch (e) {
				}					
			}
			const timer = setTimeout(check, interval);
		});
	},
	async deleteFile(filePath: string): Promise<void> {
		const uri = pathToUri(filePath);
		return vscode.workspace.fs.delete(uri);
	},
	async readFile(path: string): Promise<Uint8Array> {
		let uri: vscode.Uri;
		try {
			uri = pathToUri(path);
		} catch (e) {
			return new TextEncoder().encode(`cannot read '${path}'`);
		}

		return await vscode.workspace.fs.readFile(uri);
	},
	async writeFile(path: string, contents: Uint8Array) {
		await vscode.workspace.fs.writeFile(pathToUri(path), contents);
	}
};

function pathToUri(path: string) {
	try {
		return vscode.Uri.file(path);
	} catch (e) {
		return vscode.Uri.parse(path);
	}
}

class InlineDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {

	createDebugAdapterDescriptor(_session: vscode.DebugSession): ProviderResult<vscode.DebugAdapterDescriptor> {
		return new vscode.DebugAdapterInlineImplementation(new AplDebugSession(workspaceFileAccessor));
	}
}
