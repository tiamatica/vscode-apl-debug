/*---------------------------------------------------------
 * Copyright (C) Tiamatica. All rights reserved.
 *--------------------------------------------------------*/

'use strict';

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
	WorkspaceFolder, DebugConfiguration, ProviderResult, CancellationToken,
	TextDocument, FormattingOptions, TextEdit, Range
} from 'vscode';
import { AplDebugSession } from './aplDebug';
import { FileAccessor } from './aplRuntime';

let aplStatusBarItem: vscode.StatusBarItem;
const formatDocs = {};

interface FormatCodeRequest {
	executor: {
		resolve: (value: TextEdit[]) => void,
		reject: (reason?: any) => void
	},
	range: Range
}

export function activateAplDebug(context: vscode.ExtensionContext, factory?: vscode.DebugAdapterDescriptorFactory) {

	// create a new status bar item that we can now manage
	aplStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	aplStatusBarItem.show();
	// aplStatusBarItem.command = myCommandId;

	context.subscriptions.push(
		vscode.languages.registerDocumentRangeFormattingEditProvider('apl', {
			provideDocumentRangeFormattingEdits(document: TextDocument, range: Range, options: FormattingOptions, token: CancellationToken): ProviderResult<TextEdit[]> {
				// const firstLine = document.lineAt(0);
				const ds = vscode.debug.activeDebugSession;
				if (!ds) {
					return;
				}
				const formatResult = new Promise<vscode.TextEdit[]>((resolve, reject) => {
					formatDocs[document.fileName] = {
						executor: { resolve, reject },
						range
					};
				});
				ds.customRequest('format', {
					uri: document.fileName,
					text: document.getText(range).split(document.eol === vscode.EndOfLine.LF ? '\n' : '\r\n')
				});
				return formatResult;


				// return [vscode.TextEdit.insert(firstLine.range.start, '42\n')];
			}
		})
	);

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
		context.subscriptions.push(factory);
	}
	context.subscriptions.push(vscode.debug.onDidReceiveDebugSessionCustomEvent((customEvent) => {
		if (customEvent.event === 'statusInformation') {
			aplStatusBarItem.text = customEvent.body.text;
		} else if (customEvent.event === 'formatAplCode') {
			const documentUri = customEvent.body.win;
			const formatRequest = formatDocs[documentUri] as FormatCodeRequest;
			if (formatRequest) {
				const edit = TextEdit.replace(formatRequest.range, customEvent.body.text.join('\n'));
				formatRequest.executor.resolve([edit]);
			}
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

		provideInlineValues(document: vscode.TextDocument, viewport: vscode.Range, context: vscode.InlineValueContext): vscode.ProviderResult<vscode.InlineValue[]> {

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
	async checkExists(filePath: string, timeout: number) {
		return new Promise(function (resolve, reject) {

			var timer = setTimeout(function () {
				watcher.close();
				reject(new Error('File did not exists and was not created during the timeout.'));
			}, timeout);

			fs.access(filePath, fs.constants.R_OK, function (err) {
				if (!err) {
					clearTimeout(timer);
					watcher.close();
					resolve(true);
				}
			});

			var dir = path.dirname(filePath);
			var basename = path.basename(filePath);
			var watcher = fs.watch(dir, function (eventType, filename) {
				if (eventType === 'rename' && filename === basename) {
					clearTimeout(timer);
					watcher.close();
					resolve(true);
				}
			});
		});
	},
	async deleteFile(filePath: string) {
		return new Promise((resolve, reject) => {
			fs.rm(filePath, { force: true }, (err) => {
				if (err) {
					reject(err);
				}
				resolve(true);
			});
		});
	},
	async readFile(path: string) {
		try {
			const uri = vscode.Uri.file(path);
			const bytes = await vscode.workspace.fs.readFile(uri);
			const contents = Buffer.from(bytes).toString('utf8');
			return contents;
		} catch (e) {
			try {
				const uri = vscode.Uri.parse(path);
				const bytes = await vscode.workspace.fs.readFile(uri);
				const contents = Buffer.from(bytes).toString('utf8');
				return contents;
			} catch (e) {
				return `cannot read '${path}'`;
			}
		}
	},
};

class InlineDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {

	createDebugAdapterDescriptor(_session: vscode.DebugSession): ProviderResult<vscode.DebugAdapterDescriptor> {
		return new vscode.DebugAdapterInlineImplementation(new AplDebugSession(workspaceFileAccessor));
	}
}
