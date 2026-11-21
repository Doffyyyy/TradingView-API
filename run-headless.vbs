Set fso = CreateObject("Scripting.FileSystemObject")
workDir = fso.GetParentFolderName(WScript.ScriptFullName)
Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = workDir
WshShell.Run "cmd /c node server.js >> """ & workDir & "\server.log"" 2>&1", 0, False
