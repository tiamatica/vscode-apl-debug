# VS Code APL Debug

This is a VS Code debug adapter for APL. It connects to a Dyalog interpreter using the [RIDE protocol](https://github.com/Dyalog/ride/blob/master/docs/protocol.md)

## Using APL Debug

* Install the **APL Debug** extension in VS Code.
* Create a new codeapl script file `foo.apl` and enter several lines of text.
* Switch to the debug viewlet and press the gear dropdown.
* Select the debug environment "APL Debug".
* Press the green 'play' button to start debugging.

You can now 'step through' the `foo.apl` file.

## Build and Run

* Clone the project [https://github.com/tiamatica/vscode-apl-debug.git](https://github.com/tiamatica/vscode-apl-debug.git)
* Open the project folder in VS Code.
* Press `F5` to build and launch APL Debug in another VS Code window. In that window:
  * Open a new workspace, create a new 'program' file `readme.md` and enter several lines of arbitrary text.
  * Switch to the debug viewlet and press the gear dropdown.
  * Select the debug environment "APL Debug".
  * Press `F5` to start debugging.
