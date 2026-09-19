Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "D:\TradingView-API"
WshShell.Run "cmd /c node server.js >> D:\TradingView-API\server.log 2>&1", 0, False
