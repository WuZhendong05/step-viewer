' ============================================================
'  launch_hidden.vbs <path-to-cmd>
'
'  Launches a .cmd launcher with a HIDDEN console (window style 0) and waits
'  for it, so the Scheduled Task stays in the "Running" state for the whole
'  lifetime of the service.
'
'  Why this file exists:
'    Task Scheduler runs the task action with CreateProcess, which gives a
'    console-subsystem image (cmd.exe / python.exe) a REAL, VISIBLE console
'    window in the interactive session. The task setting <Hidden>true</Hidden>
'    only hides the task from the Task Scheduler UI -- it does NOT hide the
'    window. Closing that window sends CTRL_CLOSE_EVENT, which kills the whole
'    process tree with exit code 0xC000013A (3221225786).
'
'    wscript.exe is a GUI-subsystem image (no console of its own), and
'    WshShell.Run(..., 0, True) starts the command with SW_HIDE, so the
'    cmd.exe console is never shown. Nobody can close it by accident.
'
'  Notes:
'    - Keep this file ASCII-only (VBScript is parsed as ANSI).
'    - bWaitOnReturn=True is intentional: Stop-ScheduledTask then terminates
'      wscript, and the caller cleans up any lingering listener by port
'      (tools\healthcheck.py does this).
' ============================================================
Option Explicit

Dim args, sh, cmd, rc
Set args = WScript.Arguments

If args.Count < 1 Then
  WScript.Echo "usage: wscript launch_hidden.vbs <path-to-cmd>"
  WScript.Quit 2
End If

cmd = args(0)
If Not CreateObject("Scripting.FileSystemObject").FileExists(cmd) Then
  WScript.Echo "not found: " & cmd
  WScript.Quit 3
End If

Set sh = CreateObject("WScript.Shell")
rc = sh.Run("cmd.exe /c " & Chr(34) & cmd & Chr(34), 0, True)
WScript.Quit rc
