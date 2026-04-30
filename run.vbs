Set fso = CreateObject("Scripting.FileSystemObject")
Dim dir : dir = fso.GetParentFolderName(WScript.ScriptFullName)

Dim nmods : nmods = dir & "\node_modules"
If Not fso.FolderExists(nmods) Then
    Set WshShell = CreateObject("WScript.Shell")
    WshShell.Run "cmd /c cd /d """ & dir & """ && npm install", 1, True
    Set WshShell = Nothing
End If

Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c cd /d """ & dir & """ && npx electron .", 0, False
Set WshShell = Nothing
Set fso = Nothing
