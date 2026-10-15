' launch-hidden.vbs - launch node with NO console window (for scheduled tasks).
'
' Why: a scheduled task that runs node.exe directly shows a console window for
' as long as node lives. The 09:00 brief waits for its popup, so that would be a
' black box on screen for minutes. Run(..., 0, ...) hides only the console.
'
' Usage: wscript.exe launch-hidden.vbs "<script.js|mjs>" [args...]
' The node path is read from node-path.txt next to this file (written by
' register.mjs); falls back to "node" from PATH.
Option Explicit
Dim fso, sh, base, nodePath, script, argText, i, q
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
base = fso.GetParentFolderName(WScript.ScriptFullName)
nodePath = "node"
If fso.FileExists(base & "\node-path.txt") Then
  nodePath = Trim(fso.OpenTextFile(base & "\node-path.txt", 1).ReadAll())
End If
If WScript.Arguments.Count < 1 Then
  WScript.Quit 2
End If
script = WScript.Arguments(0)
q = Chr(34)
argText = q & nodePath & q & " " & q & script & q
For i = 1 To WScript.Arguments.Count - 1
  argText = argText & " " & q & WScript.Arguments(i) & q
Next
sh.Run argText, 0, False
