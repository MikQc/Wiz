Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\Users\mikae\Desktop\Wiz"
WScript.Sleep 3000
WshShell.Run """C:\Program Files\nodejs\node.exe"" ""C:\Users\mikae\Desktop\Wiz\src\app.js""", 0, False
