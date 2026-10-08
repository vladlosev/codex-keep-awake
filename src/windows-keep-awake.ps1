$ErrorActionPreference = "Stop"

$nativeSource = @'
using System.Runtime.InteropServices;

public static class CodexKeepAwakePower
{
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint SetThreadExecutionState(uint flags);
}
'@

Add-Type -TypeDefinition $nativeSource

$continuous = [uint32]2147483648
$active = [uint32]2147483649
$acquired = $false

try {
    if ([CodexKeepAwakePower]::SetThreadExecutionState($active) -eq [uint32]0) {
        $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        throw "SetThreadExecutionState failed with Windows error $errorCode"
    }
    $acquired = $true

    [Console]::Out.WriteLine("CODEX_KEEP_AWAKE_LEASE_READY")
    [Console]::Out.Flush()

    while ($null -ne [Console]::In.ReadLine()) { }
}
finally {
    if ($acquired) {
        [void][CodexKeepAwakePower]::SetThreadExecutionState($continuous)
    }
}
