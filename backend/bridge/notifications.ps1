# Streams real Windows toast notifications as JSON lines. No compilation needed.
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Emit($obj) {
  $json = $obj | ConvertTo-Json -Compress -Depth 5
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

try {
  [Windows.UI.Notifications.Management.UserNotificationListener, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.UI.Notifications.KnownNotificationBindings, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Json.JsonObject, Windows.Data.Json, ContentType = WindowsRuntime] | Out-Null

  # WinRT IAsyncOperation ko await karne ka helper
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]

  function Await($op, $type) {
    $m = $asTask.MakeGenericMethod($type)
    $t = $m.Invoke($null, @($op))
    $t.Wait(-1) | Out-Null
    $t.Result
  }

  $listener = [Windows.UI.Notifications.Management.UserNotificationListener]::Current
  $access = Await $listener.RequestAccessAsync() ([Windows.UI.Notifications.Management.UserNotificationListenerAccessStatus])

  if ($access -ne [Windows.UI.Notifications.Management.UserNotificationListenerAccessStatus]::Allowed) {
    Emit @{ type = "error"; reason = "notification access denied"; status = "$access" }
    exit 1
  }

  Emit @{ type = "ready"; source = "notifications" }
  $seen = @{}

  while ($true) {
    $items = Await $listener.GetNotificationsAsync([Windows.UI.Notifications.NotificationKinds]::Toast) `
                   ([System.Collections.Generic.IReadOnlyList[Windows.UI.Notifications.UserNotification]])
    $live = @{}
    foreach ($n in $items) {
      $live[$n.Id] = $true
      if ($seen.ContainsKey($n.Id)) { continue }
      $seen[$n.Id] = $true

      $app = "System"
      try { $app = $n.AppInfo.DisplayInfo.DisplayName } catch {}
      $appId = ""
      try { $appId = $n.AppInfo.AppUserModelId } catch {}

      $texts = @()
      try {
        $binding = $n.Notification.Visual.GetBinding([Windows.UI.Notifications.KnownNotificationBindings]::ToastGeneric)
        if ($binding) { foreach ($t in $binding.GetTextElements()) { $texts += $t.Text } }
      } catch {}

      $kind = "system"
      $lower = $app.ToLower()
      if ($lower -match "whatsapp|telegram|discord|slack|teams|mail|outlook|signal") { $kind = "message" }
      elseif ($lower -match "defender|security|firewall|antivirus") { $kind = "alert" }

      Emit @{
        type = "notification"
        id = "win-$($n.Id)"
        kind = $kind
        app = $app
        appId = $appId
        title = if ($texts.Count -gt 0) { $texts[0] } else { $app }
        body = if ($texts.Count -gt 1) { ($texts[1..($texts.Count-1)] -join " - ") } else { "" }
        priority = "normal"
      }
    }
    foreach ($id in @($seen.Keys)) {
      if (-not $live.ContainsKey($id)) {
        $seen.Remove($id)
        Emit @{ type = "dismiss"; id = "win-$id" }
      }
    }
    Start-Sleep -Milliseconds 1500
  }
} catch {
  Emit @{ type = "error"; reason = $_.Exception.Message }
  exit 1
}
