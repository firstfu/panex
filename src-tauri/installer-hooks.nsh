; Ship panex-cli.exe (the agent-hook helper) next to panex.exe.
; Paths are relative to the generated installer.nsi in target/release/nsis/x64/.
!macro NSIS_HOOK_POSTINSTALL
  SetOutPath $INSTDIR
  File "..\..\panex-cli.exe"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$INSTDIR\panex-cli.exe"
!macroend
