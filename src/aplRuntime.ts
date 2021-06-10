/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { EventEmitter } from 'events';
import * as cp from 'child_process';
import * as Net from 'net';
// import { Interface } from 'readline';

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

interface EchoInputMessage {
	input: string;
}

interface AppendSessionOutputMessage {
	result: string;
}

interface RideMessage {
	length: 2;
	0: string;
	1: EchoInputMessage | AppendSessionOutputMessage;
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

	// the contents (= lines) of the one and only file
	private _sourceLines: string[] = [];

	// This is the next line that will be 'executed'
	private _currentLine = 0;
	private _currentColumn: number | undefined;

	// maps from sourceFile to array of APL breakpoints
	private _breakPoints = new Map<string, IAplBreakpoint[]>();

	// since we want to send breakpoint events, we will assign an id to every event
	// so that the frontend can match events with breakpoints.
	private _breakpointId = 1;

	private _breakAddresses = new Set<string>();

	private _noDebug = false;
	private _trace = false;
	private _folder = '';

	private _namedException: string | undefined;
	private _otherExceptions = false;
	
	private _client?: Net.Socket;

	private _exe = 'dyalog.exe';
	private _child?: cp.ChildProcess;
	
	private promptType = 0;
	private mq: Array<RideMessage> = []; // mq:message queue
	private blk = 0; // blk:blocked?
	private last = 0; // last:when last rundown finished
	private tid = 0; // tid:timeout id
	private _winId = 0; // current window id

	private maxl = 1000;
	
	constructor(private _fileAccessor: FileAccessor) {
		super();
	}

	/**
	 * Start executing the given program.
	 */
	public async start(program: string, folder: string, stopOnEntry: boolean, noDebug: boolean): Promise<void> {

		this._noDebug = noDebug;
		this._folder = folder;
		this._trace = stopOnEntry;

		this.launchDyalog();
		if (program) {
			await this.loadSource(program);
			this._currentLine = -1;
			await this.verifyBreakpoints(this._sourceFile);
		}

	}

	private launchDyalog(): void {
		const env = {
            APLK0: 'default',
            AUTOCOMPLETE_PREFIXSIZE: '0',
            CLASSICMODE: '1',
            SINGLETRACE: '1',
            RIDE_SPAWNED: '1',
		};

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
				  RIDE_INIT: `CONNECT:${hp}`,
				},
			  });
			} catch (e) { this.err(e); return; }
			this._child.on('exit', (code, sig) => {
			  srv && srv.close();
			  if (code !== 0) {
				this.err(`Interpreter ${code != null ? `exited with code ${code}` : `received ${sig}`}`);
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
		const trunc = (x: string) => (x.length > this.maxl ? `${x.slice(0, this.maxl - 3)}...` : x);
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
			this.log(`recv ${trunc(m)}`);
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
		]);
	}

	private rd() { // run down the queue
		this.log('rd');
		while (this.mq.length && !this.blk) {
			const a = this.mq.shift() || ['', {}]; // a[0]:command name, a[1]:command args
			if (a[0] === 'AppendSessionOutput') { // special case: batch sequences of AppendSessionOutput together
				let s = (a[1] as AppendSessionOutputMessage).result;
				const nq = Math.min(this.mq.length, 256);
				let i: number;
				for (i = 0; i < nq && this.mq[i][0] === 'AppendSessionOutput'; i++) {
					const r = (this.mq[i][1] as AppendSessionOutputMessage).result;
					s += r;
				}
				i && this.mq.splice(0, i);
				this.add(s);
			} else {
				const f = this[a[0]];
				f ? f.apply(this, [a[1]]) : this.send('UnknownCommand', { name: a[0] });
			}
		}
		this.last = +new Date();
		this.tid = 0;
	}
	  
	private add(text: string) {
		this.sendEvent('output', text, this._sourceFile);
	}

	private rrd() { // request rundown
		this.log('rrd');
		if(!this.tid) {
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
	
	private trunc = (x) => (x.length > this.maxl ? `${x.slice(0, this.maxl - 3)}...` : x);
  	
	private toBuf(x) {
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
	private Identify(x) {
		this.remoteIdentification = x;
		this.isClassic = x.arch[0] === 'C';
		// if (this.isClassic) {
		// Object.keys(this.bq).forEach((k) => {
		// 	const sysfn = `u${this.bq[k].codePointAt(0).toString(16)}`;
		// 	if (this.syntax.sysfns_classic.includes(sysfn)) this.bq[k] = `⎕${sysfn}`;
		// });
		// this.bqbqc.forEach((p) => {
		// 	const sysfn = `u${p.text.codePointAt(0).toString(16)}`;
		// 	if (this.syntax.sysfns_classic.includes(sysfn)) p.text = `⎕${sysfn}`;
		// });
		// }
		
		// this.InitHelp(x.version);
		// ide.updTitle();
		// ide.connected = 1;
		// ide.updPW(-1);
		// clearTimeout(this.tmr);
		// delete this.tmr;
	}
		
	private InvalidSyntax() { 
		this.err('Invalid syntax.'); 
	}
	
	private Disconnect(x) {
		this.err('Interpreter disconnected: ' + x.message); 
		this.sendEvent('end');
	}

	private SysError(x) { 
		this.err('SysError: ' + x.text); 
		this.sendEvent('end');
	}
	
	private InternalError(x) { 
		this.err(`An error (${x.error}) occurred processing ${x.message}`);
	}
	private NotificationMessage(x) { 
		// this.alert(x.message, 'Notification'); 
	}
		
	private UpdateDisplayName(x) {
		// this.wsid = x.displayName;
		// this.updTitle();
		// this.wse && this.wse.refresh();
	}

	private EchoInput(x) { 
		this.add(x.input); 
	}
	
	private bannerDone = 0;

	private SetPromptType(x) {
		const t = x.type;
		this.promptType = t;
		// if (t && ide.pending.length) D.send('Execute', { trace: 0, text: `${ide.pending.shift()}\n` });
		// else eachWin((w) => { w.prompt(t); });
		// (t === 2 || t === 4) && ide.wins[0].focus(); // ⎕ / ⍞ input
		// t === 1 && ide.getStats();
		if (t === 1 && this.bannerDone === 0) {
			this.bannerDone = 1;
			if (this._sourceFile) {
				this.exec(0, `name←⊃2 ⎕FIX 'file://${this._sourceFile}'`);
				this.exec(this._trace ? 1 : 0, '⍎name');
			} else {
				this.exec(0, `⎕SE.Link.Create # '${this._folder}'`);
			}
		}
	}
		
	private HadError() {
	}

	private GotoWindow(x) {
		// const w = ide.wins[x.win]; 
		// w && w.focus();
	}
		
	private WindowTypeChanged(x) { 
		// return ide.wins[x.win].setTC(x.tracer); 
	}
	private ReplyGetAutocomplete(x) { 
		if (this._autocompletion) {
			this._autocompletion.resolve(x.options);
		}
	}
	private ReplyGetHelpInformation(x) {
		// if (x.url.length === 0) ide.getHelpExecutor.reject('No help found');
		// else ide.getHelpExecutor.resolve(x.url);
	}
	private ReplyGetLanguageBar(x) {
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
	private ReplyGetSyntaxInformation(x) {
		// D.ParseSyntaxInformation(x);
		// D.ipc && D.ipc.server.broadcast('syntax', D.syntax);
	}
	private ValueTip(x) { 
		// ide.wins[x.token].ValueTip(x); 
	}
	private SetHighlightLine(x) { 
		this._currentLine = x.line;
		this._currentColumn = undefined;
		this.sendEvent(x.line === 0 ? 'stopOnEntry' : 'stopOnStep');
		// const w = D.wins[x.win];
		// w.SetHighlightLine(x.line, ide.hadErr);
		// ide.hadErr > 0 && (ide.hadErr -= 1);
		// ide.focusWin(w);
	}
	private UpdateWindow(x) {
		// const w = ide.wins[x.token];
		// w && w.update(x);
	}
	private ReplySaveChanges(x) { 
		// const w = ide.wins[x.win]; w && w.saved(x.err); 
	}
	private CloseWindow(x) {
		// const w = ide.wins[x.win];
		// if (!w) return;
		// if (w.bwId) {
		// ide.block();
		// w.close();
		// w.id = -1;
		// } else if (w) {
		// w.me.getModel().dispose();
		// w.container && w.container.close();
		// }
		// delete ide.wins[x.win]; ide.focusMRUWin();
		// ide.WSEwidth = ide.wsew; ide.DBGwidth = ide.dbgw;
		// w.tc && ide.getStats();
	}
	private OpenWindow(x) {
		this._winId = x.token;
		// if (!ee.debugger && D.el && process.env.RIDE_EDITOR) {
		// const fs = nodeRequire('fs');
		// const os = nodeRequire('os');
		// const cp = nodeRequire('child_process');
		// const d = `${os.tmpdir()}/dyalog`;
		// fs.existsSync(d) || fs.mkdirSync(d, 7 * 8 * 8); // rwx------
		// const f = `${d}/${ee.name}.dyalog`;
		// fs.writeFileSync(f, ee.text.join('\n'), { encoding: 'utf8', mode: 6 * 8 * 8 }); // rw-------
		// const p = cp.spawn(
		// 	process.env.RIDE_EDITOR,
		// 	[f],
		// 	{ env: $.extend({}, process.env, { LINE: `${1 + (ee.currentRow || 0)}` }) },
		// );
		// p.on('error', (x) => { $.err(x); });
		// p.on('exit', () => {
		// 	const s = fs.readFileSync(f, 'utf8'); fs.unlinkSync(f);
		// 	D.send('SaveChanges', {
		// 	win: ee.token,
		// 	text: s.split('\n'),
		// 	stop: ee.stop,
		// 	trace: ee.trace,
		// 	monitor: ee.monitor,
		// 	});
		// 	D.send('CloseWindow', { win: ee.token });
		// });
		// return;
		// }
		// ide.wins[0].hadErrTmr && clearTimeout(ide.wins[0].hadErrTmr);
		// const w = ee.token;
		// let done;
		// const editorOpts = { id: w, name: ee.name, tc: ee.debugger };
		// !editorOpts.tc && (ide.hadErr = -1);
		// ide.block(); // unblock the message queue once monaco ready
		// if (D.el && D.prf.floating() && !ide.dead) {
		// D.IPC_LinkEditor({ editorOpts, ee });
		// done = 1;
		// } else if (D.elw && !D.elw.isFocused()) D.elw.focus();
		// if (done) return;
		// const ed = new D.Ed(ide, editorOpts);
		// ed.focusTS =  +new Date();
		// ide.wins[w] = ed;
		// ed.me_ready.then(() => {
		// ed.open(ee);
		// ide.unblock();
		// });
		// // add to golden layout:
		// const tc = !!ee.debugger;
		// const bro = gl.root.getComponentsByName('win').filter(x => x.id && tc === !!x.tc)[0]; // existing editor
		// let p;
		// if (bro) { // add next to existing editor
		// p = bro.container.parent.parent;
		// } else { // add to the right
		// [p] = gl.root.contentItems;
		// const t0 = tc ? 'column' : 'row';
		// if (p.type !== t0) {
		// 	const q = gl.createContentItem({ type: t0 }, p);
		// 	p.parent.replaceChild(p, q);
		// 	q.addChild(p); q.callDownwards('setSize'); p = q;
		// }
		// }
		// const ind = p.contentItems.length - !(editorOpts.tc || !!bro || !D.prf.dbg());
		// p.addChild({
		// type: 'component',
		// componentName: 'win',
		// componentState: { id: w },
		// title: ee.name,
		// }, ind);
		// ide.WSEwidth = ide.wsew; ide.DBGwidth = ide.dbgw;
		// if (tc) {
		// ide.getStats();
		// ide.wins[0].scrollCursorIntoView();
		// }
	}
	private ShowHTML(x) {
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
	private OptionsDialog(x) {
		// D.util.optionsDialog(x, (r) => {
		// D.send('ReplyOptionsDialog', { index: r, token: x.token });
		// });
	}
	private StringDialog(x) {
		// D.util.stringDialog(x, (r) => {
		// D.send('ReplyStringDialog', { value: r, token: x.token });
		// });
	}
	private TaskDialog(x) {
		this.sendEvent('taskDialog', x);
	}
	private ReplyClearTraceStopMonitor(x) {
		// $.alert(`The following items were cleared:
		// ${x.traces} traces
		// ${x.stops} stops
		// ${x.monitors} monitors`, 'Clear all trace/stop/monitor');
	}
	private ReplyGetSIStack(x) {
		// const l = x.stack.length;
		// I.sb_sis.innerText = `⎕SI: ${l}`;
		// I.sb_sis.classList.toggle('active', l > 0);
		// ide.dbg && ide.dbg.sistack.render(x.stack);
	}
	private ReplyGetThreads(x) {
		// const l = x.threads.length;
		// I.sb_threads.innerText = `&: ${l}`;
		// I.sb_threads.classList.toggle('active', l > 1);
		// ide.dbg && ide.dbg.threads.render(x.threads);
	}
	private InterpreterStatus(x) {
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
	private ReplyFormatCode(x) {
		// const w = D.wins[x.win];
		// w.ReplyFormatCode(x.text);
		// ide.hadErr > 0 && (ide.hadErr -= 1);
		// ide.focusWin(w);
	}
	private ReplyGetConfiguration(x) {
		// x.configurations.forEach((c) => {
		// 	if (c.name === 'AUTO_PAUSE_THREADS') D.prf.pauseOnError(c.value === '1');
		// });
	}
	private ReplyTreeList(x) { 
		// ide.wse.replyTreeList(x); 
	}
	private StatusOutput(x) {
		// let w = ide.wStatus;
		// if (!D.el) return;
		// if (!w) {
		// ide.wStatus = new D.el.BrowserWindow({
		// 	width: 600,
		// 	height: 400,
		// 	webPreferences: {
		// 	contextIsolation: true,
		// 	nodeIntegration: false,
		// 	},
		// });
		// w = ide.wStatus;
		// w.setTitle(`Status Output - ${document.title}`);
		// w.loadURL(`file://${__dirname}/status.html`);
		// w.on('closed', () => { delete ide.wStatus; });
		// }
		// w.webContents.executeJavaScript(`add(${JSON.stringify(x)})`);
	}
	private ReplyGetLog(x) { 
		this.add(x.result.join('\n')); 
		// this.bannerDone = 0; 
	}
	private UnknownCommand(x) {
		// if (x.name === 'ClearTraceStopMonitor') {
		// toastr.warning('Clear all trace/stop/monitor not supported by the interpreter');
		// } else if (x.name === 'GetHelpInformation') {
		// ide.getHelpExecutor.reject('GetHelpInformation not implemented on remote interpreter');
		// } else if (x.name === 'Subscribe') {
		// // flag to fallback for status updates.
		// ide.hasSubscribe = false;
		// I.sb_ml.hidden = true;
		// I.sb_io.hidden = true;
		// I.sb_trap.hidden = true;
		// I.sb_dq.hidden = true;
		// I.sb_cc.hidden = true;
		// I.sb_gc.hidden = true;
		// toggleStats();
		// } else if (x.name === 'GetConfiguration') {
		// D.get_configuration_na = 1;
		// updMenu();
		// }
	}

	/**
	 * Execute expression
	 */
	 public execute(expr: string) {
		this.exec(0, expr);
	}

	private _autocompletion: any;
	/**
	 * Reply to TaskDialog
	 */
	public getAutocomplete(line: string, pos: number, token: number): PromiseLike<string[]> {
		return new Promise((resolve, reject) => {
			this._autocompletion = { resolve, reject };
			this.send('GetAutocomplete', { line, pos, token });
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
		this.sendEvent('stopOnStep');
		
	}

	/**
	 * "Step out" for APL debug means: go to previous character
	 */
	public stepOut() {
		if (typeof this._currentColumn === 'number') {
			this._currentColumn -= 1;
			if (this._currentColumn === 0) {
				this._currentColumn = undefined;
			}
		}
		this.sendEvent('stopOnStep');
	}

	public getStepInTargets(frameId: number): IStepInTargets[] {

		const line = this._sourceLines[this._currentLine].trim();

		// every word of the current line becomes a stack frame.
		const words = line.split(/\s+/);

		// return nothing if frameId is out of range
		if (frameId < 0 || frameId >= words.length) {
			return [];
		}

		// pick the frame for the given frameId
		const frame = words[frameId];

		const pos = line.indexOf(frame);

		// make every character of the frame a potential "step in" target
		return frame.split('').map((c, ix) => {
			return {
				id: pos + ix,
				label: `target: ${c}`
			};
		});
	}

	/**
	 * Returns a fake 'stacktrace' where every 'stackframe' is a word from the current line.
	 */
	public stack(startFrame: number, endFrame: number): IStack {

		const words = this._sourceLines[this._currentLine].trim().split(/\s+/);

		const frames = new Array<IStackFrame>();
		// every word of the current line becomes a stack frame.
		for (let i = startFrame; i < Math.min(endFrame, words.length); i++) {
			const name = words[i];	// use a word of the line as the stackframe name
			const stackFrame: IStackFrame = {
				index: i,
				name: `${name}(${i})`,
				file: this._sourceFile,
				line: this._currentLine
			};
			if (typeof this._currentColumn === 'number') {
				stackFrame.column = this._currentColumn;
			}
			frames.push(stackFrame);
		}
		return {
			frames: frames,
			count: words.length
		};
	}

	public getBreakpoints(path: string, line: number): number[] {

		const l = this._sourceLines[line];

		let sawSpace = true;
		const bps: number[] = [];
		for (let i = 0; i < l.length; i++) {
			if (l[i] !== ' ') {
				if (sawSpace) {
					bps.push(i);
					sawSpace = false;
				}
			} else {
				sawSpace = true;
			}
		}

		return bps;
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
	 * Set data breakpoint.
	 */
	public setDataBreakpoint(address: string): boolean {
		if (address) {
			this._breakAddresses.add(address);
			return true;
		}
		return false;
	}

	public setExceptionsFilters(namedException: string | undefined, otherExceptions: boolean): void {
		this._namedException = namedException;
		this._otherExceptions = otherExceptions;
	}

	/*
	 * Clear all data breakpoints.
	 */
	public clearAllDataBreakpoints(): void {
		this._breakAddresses.clear();
	}

	// private methods

	private async loadSource(file: string): Promise<void> {
		if (this._sourceFile !== file) {
			this._sourceFile = file;
			const contents = await this._fileAccessor.readFile(file);
			this._sourceLines = contents.split(/\r?\n/);
		}
	}

	/**
	 * Run through the file.
	 * If stepEvent is specified only run a single step and emit the stepEvent.
	 */
	private run(reverse = false, stepEvent?: string) {
		if (reverse) {
			this.send('TraceBackward', { win: this._winId });
		} else {
			this.send('RunCurrentLine', { win: this._winId });
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
			await this.loadSource(path);
			bps.forEach(bp => {
				if (!bp.verified && bp.line < this._sourceLines.length) {
					const srcLine = this._sourceLines[bp.line].trim();

					// if a line is empty or starts with '+' we don't allow to set a breakpoint but move the breakpoint down
					if (srcLine.length === 0 || srcLine.indexOf('+') === 0) {
						bp.line++;
					}
					// if a line starts with '-' we don't allow to set a breakpoint but move the breakpoint up
					if (srcLine.indexOf('-') === 0) {
						bp.line--;
					}
					// don't set 'verified' to true if the line contains the word 'lazy'
					// in this case the breakpoint will be verified 'lazy' after hitting it once.
					if (srcLine.indexOf('lazy') < 0) {
						bp.verified = true;
						this.sendEvent('breakpointValidated', bp);
					}
				}
			});
		}
	}

	private sendEvent(event: string, ... args: any[]) {
		setImmediate(_ => {
			this.emit(event, ...args);
		});
	}
}