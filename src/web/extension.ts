/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import { activateAplDebug } from '../activateAplDebug';

export function activate(context: vscode.ExtensionContext) {
	activateAplDebug(context);
}

export function deactivate() {
	// nothing to do
}
