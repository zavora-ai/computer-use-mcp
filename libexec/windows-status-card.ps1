param([Parameter(Mandatory = $true)][string]$Directory)

# The Windows desktop status card for computer-use-mcp (7.6.1). Lineage: PR #40 by ShakeCrane (an opt-in WPF card with
# the same two files), with three changes from its review: the card watches the server's pid and closes when it is gone,
# it is excluded from screen capture (WDA_EXCLUDEFROMCAPTURE) so the agent never sees its own controls, and it shows
# the tool, app and window the server resolved rather than a bucketed verb.
#
# Protocol: $Directory holds state.json (written by the server) and control.txt (written here: running | paused | stopped).
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

$controlFile = Join-Path $Directory 'control.txt'
$stateFile = Join-Path $Directory 'state.json'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ComputerUseCardNative {
  [DllImport("user32.dll")] public static extern bool SetWindowDisplayAffinity(IntPtr hwnd, uint affinity);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
}
'@

[xml]$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Width="344" Height="168" SizeToContent="Manual"
        WindowStyle="None" ResizeMode="NoResize"
        AllowsTransparency="True" Background="Transparent"
        ShowInTaskbar="False" ShowActivated="False" Topmost="True"
        WindowStartupLocation="Manual" FontFamily="Segoe UI">
 <Border x:Name="Outer" Margin="10" CornerRadius="14" Background="#F7FAFBFE" BorderBrush="#E3E6EC" BorderThickness="1">
  <Border.Effect><DropShadowEffect BlurRadius="16" ShadowDepth="2" Opacity="0.18" Color="#313747"/></Border.Effect>
  <Grid Margin="16,12,16,12">
   <Grid.RowDefinitions>
    <RowDefinition Height="22"/><RowDefinition Height="20"/><RowDefinition Height="*"/><RowDefinition Height="30"/>
   </Grid.RowDefinitions>
   <StackPanel Orientation="Horizontal" Grid.Row="0" x:Name="Header" Cursor="SizeAll">
    <Ellipse x:Name="Dot" Width="9" Height="9" Fill="#3B82F6" Margin="0,0,8,0" VerticalAlignment="Center"/>
    <TextBlock x:Name="Title" FontSize="13" FontWeight="SemiBold" Foreground="#1F2430" VerticalAlignment="Center" Text="Agent is using this PC"/>
   </StackPanel>
   <TextBlock x:Name="Action" Grid.Row="1" FontSize="12" Foreground="#5B6472" TextTrimming="CharacterEllipsis" Text="Idle"/>
   <StackPanel Grid.Row="2" Margin="0,2,0,0">
    <TextBlock x:Name="Recent0" FontSize="11" Foreground="#8A919E" TextTrimming="CharacterEllipsis"/>
    <TextBlock x:Name="Recent1" FontSize="11" Foreground="#8A919E" TextTrimming="CharacterEllipsis"/>
    <TextBlock x:Name="Recent2" FontSize="11" Foreground="#8A919E" TextTrimming="CharacterEllipsis"/>
   </StackPanel>
   <StackPanel Grid.Row="3" Orientation="Horizontal" HorizontalAlignment="Right" VerticalAlignment="Bottom">
    <Button x:Name="Pause" Content="Pause" Width="70" Height="26" FontSize="12" Margin="0,0,8,0" Cursor="Hand"/>
    <Button x:Name="Stop" Content="Stop" Width="62" Height="26" FontSize="12" Foreground="#AD3B3B" Cursor="Hand"/>
   </StackPanel>
  </Grid>
 </Border>
</Window>
'@
$reader = New-Object System.Xml.XmlNodeReader($xaml)
$window = [Windows.Markup.XamlReader]::Load($reader)
$header = $window.FindName('Header'); $dot = $window.FindName('Dot'); $title = $window.FindName('Title')
$action = $window.FindName('Action'); $pause = $window.FindName('Pause'); $stop = $window.FindName('Stop')
$recent = @('Recent0', 'Recent1', 'Recent2') | ForEach-Object { $window.FindName($_) }

$area = [System.Windows.SystemParameters]::WorkArea
$window.Left = $area.Right - $window.Width - 12
$window.Top = $area.Top + 12
$header.Add_MouseLeftButtonDown({ try { $window.DragMove() } catch {} })
$window.Add_SourceInitialized({
  # Excluded from screen capture (Windows 10 2004+), so screenshots never contain the card.
  $handle = (New-Object System.Windows.Interop.WindowInteropHelper($window)).Handle
  [ComputerUseCardNative]::SetWindowDisplayAffinity($handle, 0x11) | Out-Null
})
# 7.7.0: tell the server the card is on screen (until now it counted a PowerShell that exited at once as launched).
$window.Add_ContentRendered({
  try {
    $handle = (New-Object System.Windows.Interop.WindowInteropHelper($window)).Handle
    $ready = '{"hwnd":' + [int64]$handle + ',"rect":[' + [int]$window.Left + ',' + [int]$window.Top + ',' + [int]$window.Width + ',' + [int]$window.Height + ']}'
    [System.IO.File]::WriteAllText((Join-Path $Directory 'windows-card.json'), $ready)
  } catch {}
  Publish-Geometry
})

# 7.8.1: the card is excluded from capture, so the agent aims at whatever it sees beneath it. The card says where it
# is (card.json, screen pixels) and moves to a clear corner when the server asks (dodge.json), before input lands there.
function Write-Atomic([string]$path, [string]$text) {
  $tmp = "$path.$PID.tmp"
  try {
    [System.IO.File]::WriteAllText($tmp, $text)
    if (Test-Path $path) { [System.IO.File]::Replace($tmp, $path, [NullString]::Value) } else { [System.IO.File]::Move($tmp, $path) }
  } catch { try { [System.IO.File]::WriteAllText($path, $text) } catch {} }
}
function Publish-Geometry {
  try {
    $handle = (New-Object System.Windows.Interop.WindowInteropHelper($window)).Handle
    $r = New-Object 'ComputerUseCardNative+RECT'
    if ([ComputerUseCardNative]::GetWindowRect($handle, [ref]$r)) {
      $json = '{"frame":{"x":' + $r.Left + ',"y":' + $r.Top + ',"width":' + ($r.Right - $r.Left) + ',"height":' + ($r.Bottom - $r.Top) + '},"pid":' + $PID + '}'
      Write-Atomic (Join-Path $Directory 'card.json') $json
    }
  } catch {}
}
$script:dodgeSeq = -1
function Test-Clear($left, $top, $points) {
  foreach ($p in $points) {
    if ($p.X -ge ($left - 8) -and $p.X -lt ($left + $window.Width + 8) -and $p.Y -ge ($top - 8) -and $p.Y -lt ($top + $window.Height + 8)) { return $false }
  }
  return $true
}
function Invoke-Dodge {
  $file = Join-Path $Directory 'dodge.json'
  if (-not (Test-Path $file)) { return }
  try { $request = [System.IO.File]::ReadAllText($file) | ConvertFrom-Json } catch { return }
  if ($null -eq $request -or $null -eq $request.seq -or [int]$request.seq -eq $script:dodgeSeq) { return }
  $script:dodgeSeq = [int]$request.seq
  # The server's points are screen pixels; the window is placed in device-independent units.
  $scaleX = 1.0; $scaleY = 1.0
  $source = [System.Windows.PresentationSource]::FromVisual($window)
  if ($source -and $source.CompositionTarget) { $scaleX = $source.CompositionTarget.TransformToDevice.M11; $scaleY = $source.CompositionTarget.TransformToDevice.M22 }
  $points = @($request.avoid | ForEach-Object { New-Object System.Windows.Point(([double]$_[0] / $scaleX), ([double]$_[1] / $scaleY)) })
  if (-not (Test-Clear $window.Left $window.Top $points)) {
    $area = [System.Windows.SystemParameters]::WorkArea
    $corners = @(
      @(($area.Right - $window.Width - 12), ($area.Top + 12)),
      @(($area.Right - $window.Width - 12), ($area.Bottom - $window.Height - 12)),
      @(($area.Left + 12), ($area.Bottom - $window.Height - 12)),
      @(($area.Left + 12), ($area.Top + 12))
    )
    foreach ($corner in $corners) {
      if (Test-Clear $corner[0] $corner[1] $points) { $window.Left = $corner[0]; $window.Top = $corner[1]; break }
    }
  }
  Publish-Geometry
}
$window.Add_LocationChanged({ Publish-Geometry })

function Write-Control([string]$value) {
  try {
    $tmp = "$controlFile.$PID.tmp"
    [System.IO.File]::WriteAllText($tmp, $value)
    [System.IO.File]::Move($tmp, $controlFile, $true)
  } catch { try { [System.IO.File]::WriteAllText($controlFile, $value) } catch {} }
}
function Read-Control { try { return [System.IO.File]::ReadAllText($controlFile).Trim().ToLowerInvariant() } catch { return 'running' } }

$script:frame = $null
$pause.Add_Click({
  $mode = Read-Control
  if ($mode -eq 'stopped') { return }
  Write-Control $(if ($mode -eq 'paused') { 'running' } else { 'paused' })
})
# 7.7.0: once stopped, the button reads Close and dismisses the card; the server keeps the stopped state.
$stop.Add_Click({ if ((Read-Control) -eq 'stopped') { $window.Close() } else { Write-Control 'stopped' } })

function Describe($item) {
  $text = [string]$item.label
  if ($item.app) {
    $name = [string]$item.app
    try { $proc = Get-Process -Name ([System.IO.Path]::GetFileNameWithoutExtension($name)) -ErrorAction SilentlyContinue | Select-Object -First 1; if ($proc -and $proc.MainWindowTitle) { } } catch {}
    $text += " in $name"
    if ($item.window) { $text += " · " + [string]$item.window }
  }
  return $text
}

$timer = New-Object Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(200)
$timer.Add_Tick({
  if (-not (Test-Path $controlFile)) { $window.Close(); return }
  if (Test-Path $stateFile) {
    try { $script:frame = [System.IO.File]::ReadAllText($stateFile) | ConvertFrom-Json } catch {}
  }
  if ($null -ne $script:frame -and $script:frame.pid) {
    # The server is gone: leave nothing on screen.
    if (-not (Get-Process -Id ([int]$script:frame.pid) -ErrorAction SilentlyContinue)) { $window.Close(); return }
  }
  $mode = Read-Control
  $state = if ($null -ne $script:frame) { [string]$script:frame.state } else { 'running' }
  if ($mode -eq 'stopped') { $state = 'stopped' } elseif ($mode -eq 'paused') { $state = 'paused' }
  $elapsed = '0:00'
  if ($null -ne $script:frame) {
    $seconds = [int][Math]::Max(0, ((Get-Date) - [DateTimeOffset]::FromUnixTimeMilliseconds([long]$script:frame.startedAt).LocalDateTime).TotalSeconds)
    $elapsed = if ($seconds -ge 3600) { '{0}:{1:00}:{2:00}' -f [int]($seconds / 3600), [int](($seconds % 3600) / 60), ($seconds % 60) } else { '{0}:{1:00}' -f [int]($seconds / 60), ($seconds % 60) }
  }
  $current = if ($null -ne $script:frame -and $script:frame.action) { Describe $script:frame.action } else { 'Idle' }
  switch ($state) {
    'stopped' { $dot.Fill = '#D64545'; $title.Text = "Agent stopped · $elapsed"; $action.Text = 'No further desktop input this session. Restart the server to resume.'; $pause.IsEnabled = $false; $stop.Content = 'Close'; $stop.IsEnabled = $true }
    'paused'  {
      $dot.Fill = '#E8A33D'; $pause.Content = 'Resume'; $pause.IsEnabled = $true; $stop.IsEnabled = $true
      if ($null -ne $script:frame -and $script:frame.handoff) {
        $title.Text = "Your turn · $elapsed"; $action.Text = [string]$script:frame.handoff.message + ' Press Resume when you are done.'
      } elseif ($null -ne $script:frame -and [string]$script:frame.reason -eq 'takeover') {
        $title.Text = "You took over · $elapsed"; $action.Text = 'The agent waits while you use the mouse or keyboard, and resumes when you stop.'
      } elseif ($null -ne $script:frame -and $script:frame.watching) {
        $title.Text = "Agent paused · $elapsed"; $action.Text = 'The watch sees nothing and nothing is changed until you resume.'
      } else {
        $title.Text = "Agent paused · $elapsed"; $action.Text = 'Mutations are refused; it can still look. Resume when you are ready.'
      }
    }
    default {
      $pause.Content = 'Pause'; $pause.IsEnabled = $true; $stop.IsEnabled = $true
      $waiting = if ($null -ne $script:frame) { [string]$script:frame.waiting } else { '' }
      if ($waiting -eq 'user_active') { $dot.Fill = '#E8A33D'; $title.Text = "Agent waiting for you · $elapsed"; $action.Text = 'You are typing or moving the mouse; it resumes when you stop.' }
      elseif ($waiting -eq 'approval') { $dot.Fill = '#E8A33D'; $title.Text = "Agent needs approval · $elapsed"; $action.Text = $current }
      elseif ($null -ne $script:frame -and $script:frame.watching -and -not $script:frame.action) {
        # 7.8: watching without acting: say what it can see, and that Pause stops it seeing.
        $dot.Fill = '#A855F7'; $title.Text = "Agent is watching this PC · $elapsed"; $action.Text = "Sees $([string]$script:frame.watching.target). Pause and it sees nothing."
      }
      else {
        $dot.Fill = '#3B82F6'; $title.Text = "Agent is using this PC · $elapsed"; $action.Text = $current
        $chord = if ($null -ne $script:frame) { [string]$script:frame.chord } else { '' }
        if ($current -eq 'Idle' -and $chord) { $action.Text = "Idle · $(($chord -split '\+' | ForEach-Object { $_.Substring(0,1).ToUpper() + $_.Substring(1) }) -join '+') stops it from any app" }
      }
    }
  }
  $chordText = if ($null -ne $script:frame) { [string]$script:frame.chord } else { '' }
  $stop.ToolTip = if ($chordText) { "Stop the agent for this session (or press $chordText anywhere)" } else { 'Stop the agent for this session' }
  $items = @()
  if ($null -ne $script:frame -and $script:frame.recent) { $items = @($script:frame.recent) }
  for ($i = 0; $i -lt $recent.Count; $i++) {
    if ($i -lt $items.Count) {
      $mark = if ($items[$i].outcome -eq 'failed') { 'x' } else { 'ok' }
      $recent[$i].Text = "$mark  " + (Describe $items[$i])
      $recent[$i].Foreground = if ($items[$i].outcome -eq 'failed') { '#B14C4C' } else { '#8A919E' }
    } else { $recent[$i].Text = '' }
  }
})
$timer.Start()
# 7.8.1: a quick look for a move request, so a click under the card waits tens of milliseconds, not a whole tick.
$dodgeTimer = New-Object Windows.Threading.DispatcherTimer
$dodgeTimer.Interval = [TimeSpan]::FromMilliseconds(40)
$dodgeTimer.Add_Tick({ Invoke-Dodge })
$dodgeTimer.Start()
try { $null = $window.ShowDialog() } finally { $timer.Stop(); $dodgeTimer.Stop() }
