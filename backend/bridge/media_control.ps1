# Real Windows media session: reads metadata AND accepts control commands via stdin.
# Also reads/writes the actual Windows master volume endpoint.
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Emit($o) {
  [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress -Depth 6))
  [Console]::Out.Flush()
}

try {
  [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime] | Out-Null
  [Windows.Storage.Streams.RandomAccessStreamReference, Windows.Storage.Streams, ContentType=WindowsRuntime] | Out-Null
  Add-Type -AssemblyName System.Runtime.WindowsRuntime

  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
  function Await($op, $type) {
    $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
    $t.Wait(-1) | Out-Null
    $t.Result
  }

  # ---- master volume via CoreAudio COM ----
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Collections.Concurrent;
using System.Threading;

[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int RegisterControlChangeNotify(IntPtr n);
  int UnregisterControlChangeNotify(IntPtr n);
  int GetChannelCount(out int c);
  int SetMasterVolumeLevel(float l, ref Guid g);
  int SetMasterVolumeLevelScalar(float l, ref Guid g);
  int GetMasterVolumeLevel(out float l);
  int GetMasterVolumeLevelScalar(out float l);
  int SetChannelVolumeLevel(uint c, float l, Guid g);
  int SetChannelVolumeLevelScalar(uint c, float l, Guid g);
  int GetChannelVolumeLevel(uint c, out float l);
  int GetChannelVolumeLevelScalar(uint c, out float l);
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool m, ref Guid g);
  int GetMute(out bool m);
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
  int Activate(ref Guid iid, uint clsctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o);
  int OpenPropertyStore(uint access, [MarshalAs(UnmanagedType.Interface)] out IPropertyStore store);
  int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
  int GetState(out uint state);
}

[StructLayout(LayoutKind.Sequential)]
struct PROPERTYKEY {
  public Guid formatId;
  public uint propertyId;
}

[StructLayout(LayoutKind.Explicit)]
struct PROPVARIANT {
  [FieldOffset(0)] public ushort variantType;
  [FieldOffset(8)] public IntPtr stringValue;
}

[Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPropertyStore {
  int GetCount(out uint count);
  int GetAt(uint index, out PROPERTYKEY key);
  int GetValue(ref PROPERTYKEY key, out PROPVARIANT value);
  int SetValue(ref PROPERTYKEY key, ref PROPVARIANT value);
  int Commit();
}

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
  int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
  int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumerator { }

public static class Vol {
  [DllImport("ole32.dll")]
  static extern int PropVariantClear(ref PROPVARIANT value);

  static IMMDevice GetDevice() {
    var e = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
    IMMDevice d;
    Marshal.ThrowExceptionForHR(e.GetDefaultAudioEndpoint(0, 1, out d)); // eRender, eMultimedia
    return d;
  }
  static IAudioEndpointVolume Get() {
    var d = GetDevice();
    Guid iid = typeof(IAudioEndpointVolume).GUID;
    object o;
    Marshal.ThrowExceptionForHR(d.Activate(ref iid, 23, IntPtr.Zero, out o));
    return (IAudioEndpointVolume)o;
  }
  public static string DeviceName() {
    IPropertyStore store;
    Marshal.ThrowExceptionForHR(GetDevice().OpenPropertyStore(0, out store));
    var key = new PROPERTYKEY {
      formatId = new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0"),
      propertyId = 14
    };
    PROPVARIANT value;
    Marshal.ThrowExceptionForHR(store.GetValue(ref key, out value));
    try {
      if (value.variantType != 31) throw new InvalidOperationException("Audio device name is not a string.");
      return Marshal.PtrToStringUni(value.stringValue);
    } finally {
      PropVariantClear(ref value);
    }
  }
  public static float Read() { float v; Marshal.ThrowExceptionForHR(Get().GetMasterVolumeLevelScalar(out v)); return v; }
  public static bool Muted() { bool m; Marshal.ThrowExceptionForHR(Get().GetMute(out m)); return m; }
  public static void Write(float v) { Guid context = Guid.Empty; Marshal.ThrowExceptionForHR(Get().SetMasterVolumeLevelScalar(v, ref context)); }
  public static void SetMute(bool m) { Guid context = Guid.Empty; Marshal.ThrowExceptionForHR(Get().SetMute(m, ref context)); }
}

public static class MediaKeys {
  [DllImport("user32.dll")]
  static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extraInfo);
  public static void Press(int key) {
    keybd_event((byte)key, 0, 0, UIntPtr.Zero);
    keybd_event((byte)key, 0, 2, UIntPtr.Zero);
  }
}

public static class MediaCommandReader {
  public static readonly ConcurrentQueue<string> Commands = new ConcurrentQueue<string>();
  public static void Start() {
    var thread = new Thread(() => {
      string line;
      while ((line = Console.In.ReadLine()) != null) {
        if (!String.IsNullOrWhiteSpace(line)) Commands.Enqueue(line);
      }
    });
    thread.IsBackground = true;
    thread.Start();
  }
}
"@

  $mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) `
               ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])

  function Get-TargetSession {
    $current = $mgr.GetCurrentSession()
    if ($null -ne $current) {
      $currentPlayback = $current.GetPlaybackInfo()
      if ($currentPlayback.PlaybackStatus -eq [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackStatus]::Playing) {
        return $current
      }
    }

    $sessions = $mgr.GetSessions()
    foreach ($session in $sessions) {
      $playback = $session.GetPlaybackInfo()
      if ($playback.PlaybackStatus -eq [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackStatus]::Playing) {
        return $session
      }
    }
    if ($null -ne $current) { return $current }
    foreach ($session in $sessions) {
      $playback = $session.GetPlaybackInfo()
      if ($playback.PlaybackStatus -eq [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackStatus]::Paused) {
        return $session
      }
    }
    return $null
  }

  Emit @{ type="ready"; source="media"; controls=$true; volume=$true }

  # ---- background stdin command reader ----
  [MediaCommandReader]::Start()

  $lastKey = ""
  $lastVol = -1.0
  $lastMute = $null
  $lastVolumeError = ""
  $lastDevice = ""
  $lastDeviceError = ""

  while ($true) {
    # ---- handle inbound control commands ----
    $cmd = $null
    while ([MediaCommandReader]::Commands.TryDequeue([ref]$cmd)) {
      try {
        $j = $cmd | ConvertFrom-Json
        $act = $j.action

        if ($act -eq "volume") {
          $value = [math]::Max(0.0, [math]::Min(1.0, [double]$j.value))
          [Vol]::Write([float]$value)
          if ($value -gt 0 -and [Vol]::Muted()) { [Vol]::SetMute($false) }
          Emit @{ type="volume"; value=[Vol]::Read(); muted=[Vol]::Muted() }
          continue
        }
        if ($act -in @("volume_up", "volume_down")) {
          $delta = if ($act -eq "volume_up") { 0.05 } else { -0.05 }
          $value = [math]::Max(0.0, [math]::Min(1.0, [Vol]::Read() + $delta))
          [Vol]::Write([float]$value)
          if ($value -gt 0 -and [Vol]::Muted()) { [Vol]::SetMute($false) }
          Emit @{ type="volume"; value=[Vol]::Read(); muted=[Vol]::Muted() }
          continue
        }
        if ($act -eq "mute") {
          [Vol]::SetMute([bool]$j.value)
          Emit @{ type="volume"; value=[Vol]::Read(); muted=[Vol]::Muted() }
          continue
        }

        $s = Get-TargetSession
        if ($null -eq $s) {
          $key = switch ($act) {
            { $_ -in @("play", "pause", "toggle") } { 0xB3; break }
            "next" { 0xB0; break }
            "previous" { 0xB1; break }
            default { $null }
          }
          if ($null -ne $key) { [MediaKeys]::Press($key); continue }
          Emit @{ type="error"; reason="no active media session for $act" }
          continue
        }

        $ok = $true
        switch ($act) {
          "play"     { $ok = Await $s.TryPlayAsync() ([bool]) }
          "pause"    { $ok = Await $s.TryPauseAsync() ([bool]) }
          "toggle"   { $ok = Await $s.TryTogglePlayPauseAsync() ([bool]) }
          "next"     { $ok = Await $s.TrySkipNextAsync() ([bool]) }
          "previous" { $ok = Await $s.TrySkipPreviousAsync() ([bool]) }
          "seek"     {
            $start = $s.GetTimelineProperties().StartTime.TotalSeconds
            $ticks = [int64](($start + [double]$j.seconds) * 10000000)
            $ok = Await $s.TryChangePlaybackPositionAsync($ticks) ([bool])
          }
        }
        if (-not $ok) {
          $key = switch ($act) {
            { $_ -in @("play", "pause", "toggle") } { 0xB3; break }
            "next" { 0xB0; break }
            "previous" { 0xB1; break }
            default { $null }
          }
          if ($null -ne $key) { [MediaKeys]::Press($key) }
          else { Emit @{ type="error"; reason="$act is not supported by the current media session" } }
        }
      } catch {
        Emit @{ type="error"; reason=$_.Exception.Message }
      }
    }

    # ---- poll volume ----
    try {
      $v = [Vol]::Read()
      $m = [Vol]::Muted()
      $lastVolumeError = ""
      if ([math]::Abs($v - $lastVol) -gt 0.005 -or $m -ne $lastMute) {
        $lastVol = $v
        $lastMute = $m
        Emit @{ type="volume"; value=$v; muted=$m }
      }
    } catch {
      $reason = "System volume read failed: $($_.Exception.Message)"
      if ($reason -ne $lastVolumeError) {
        $lastVolumeError = $reason
        Emit @{ type="error"; reason=$reason }
      }
    }

    try {
      $device = [Vol]::DeviceName()
      $lastDeviceError = ""
      if ($device -ne $lastDevice) {
        $lastDevice = $device
        Emit @{ type="device"; name=$device }
      }
    } catch {
      $reason = "Audio output device read failed: $($_.Exception.Message)"
      if ($reason -ne $lastDeviceError) {
        $lastDeviceError = $reason
        Emit @{ type="error"; reason=$reason }
      }
    }

    # ---- poll session ----
    $s = Get-TargetSession
    if ($null -eq $s) {
      if ($lastKey -ne "none") { $lastKey="none"; Emit @{ type="media"; playing=$false; available=$false } }
    } else {
      $p  = Await $s.TryGetMediaPropertiesAsync() ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
      $pb = $s.GetPlaybackInfo()
      $tl = $s.GetTimelineProperties()
      $playing = $pb.PlaybackStatus -eq [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackStatus]::Playing

      $start = $tl.StartTime.TotalSeconds
      $dur   = [math]::Max(0, $tl.EndTime.TotalSeconds - $start)
      $posn  = [math]::Max(0, $tl.Position.TotalSeconds - $start)
      if ($dur -gt 0) { $posn = [math]::Min($posn, $dur) }

      # thumbnail -> base64 (real album art)
      $thumb = $null
      try {
        if ($p.Thumbnail) {
          $rs = Await $p.Thumbnail.OpenReadAsync() ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
          $size = [int]$rs.Size
          if ($size -gt 0 -and $size -lt 400000) {
            $buf = New-Object byte[] $size
            $dr = New-Object System.IO.StreamReader($rs.AsStreamForRead())
            $ms = New-Object System.IO.MemoryStream
            $rs.AsStreamForRead().CopyTo($ms)
            $bytes = $ms.ToArray()
            $ct = if ($rs.ContentType) { $rs.ContentType } else { "image/jpeg" }
            $thumb = "data:$ct;base64," + [Convert]::ToBase64String($bytes)
          }
        }
      } catch {}

      $canSeek = [bool]$pb.Controls.IsPlaybackPositionEnabled
      $canNext = [bool]$pb.Controls.IsNextEnabled
      $canPrev = [bool]$pb.Controls.IsPreviousEnabled
      $key = "$($s.SourceAppUserModelId)|$($p.Title)|$($p.Artist)|$playing|$([math]::Round($posn, 1))|$dur|$canSeek|$canNext|$canPrev"
      if ($key -ne $lastKey) {
        $lastKey = $key
        Emit @{
          type="media"; available=$true; playing=[bool]$playing
          title=if($p.Title){$p.Title}else{"Unknown"}
          artist=if($p.Artist){$p.Artist}else{""}
          album=if($p.AlbumTitle){$p.AlbumTitle}else{""}
          source=$s.SourceAppUserModelId
          position=$posn; duration=$dur
          thumbnail=$thumb
          canSeek=$canSeek
          canNext=$canNext
          canPrev=$canPrev
        }
      }
    }
    Start-Sleep -Milliseconds 700
  }
} catch {
  Emit @{ type="error"; reason=$_.Exception.Message }
  exit 1
}
