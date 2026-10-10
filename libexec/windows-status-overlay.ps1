param([Parameter(Mandatory = $true)][string]$SessionDirectory)

# Original, asset-free status UI inspired by unobtrusive desktop operation cards.
# Invoked only by the local Computer Use MCP process. No network transport.
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

$controlFile = Join-Path $SessionDirectory 'control.txt'
$stateFile = Join-Path $SessionDirectory 'state.json'
[xml]$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Width="344" Height="213" SizeToContent="Manual"
        WindowStyle="None" ResizeMode="NoResize"
        AllowsTransparency="True" Background="Transparent"
        ShowInTaskbar="False" ShowActivated="False" Topmost="True"
        WindowStartupLocation="Manual" FontFamily="Segoe UI">
 <Border x:Name="Outer" Margin="12" CornerRadius="18" Background="#FCFCFE"
         BorderBrush="#E9E9EF" BorderThickness="1">
  <Border.Effect>
   <DropShadowEffect BlurRadius="18" ShadowDepth="3" Opacity="0.17" Color="#313747"/>
  </Border.Effect>
  <Grid>
   <Grid.RowDefinitions>
    <RowDefinition Height="41"/>
    <RowDefinition Height="*"/>
   </Grid.RowDefinitions>
   <Grid x:Name="Header" Margin="20,9,15,1" Grid.Row="0" Cursor="SizeAll">
    <Grid.ColumnDefinitions>
     <ColumnDefinition Width="*"/>
     <ColumnDefinition Width="30"/>
    </Grid.ColumnDefinitions>
    <StackPanel Orientation="Horizontal" VerticalAlignment="Center">
     <Ellipse x:Name="ActivityDot" Width="7" Height="7" Fill="#46A4F4"
              Margin="0,0,8,0"/>
     <TextBlock x:Name="Elapsed" FontSize="12.5" Foreground="#7C8390"
                VerticalAlignment="Center" Text="Operated for 0 seconds"/>
    </StackPanel>
    <Button x:Name="Expand" Content="^" Grid.Column="1"
            Width="27" Height="27" FontSize="13" Foreground="#747B87"
            Background="Transparent" BorderThickness="0" Cursor="Hand"/>
   </Grid>
   <Grid x:Name="Details" Grid.Row="1" Margin="24,0,21,15">
    <Grid.RowDefinitions>
     <RowDefinition Height="*"/>
     <RowDefinition Height="37"/>
    </Grid.RowDefinitions>
    <Grid Margin="3,0,0,0">
     <Grid.ColumnDefinitions>
      <ColumnDefinition Width="19"/>
      <ColumnDefinition Width="*"/>
     </Grid.ColumnDefinitions>
     <Rectangle Margin="4,7,0,8" Width="1" Fill="#E0E3E9"
                HorizontalAlignment="Left"/>
     <StackPanel Grid.Column="1" VerticalAlignment="Center">
      <TextBlock x:Name="Step0" Text="Initializing" FontSize="13"
                 Foreground="#333942" Margin="0,0,0,9"/>
      <TextBlock x:Name="Step1" Text="Waiting for an agent" FontSize="13"
                 Foreground="#333942" Margin="0,0,0,9"/>
      <TextBlock x:Name="Step2" Text="" FontSize="13"
                 Foreground="#333942" Margin="0,0,0,9"/>
      <TextBlock x:Name="Step3" Text="" FontSize="13"
                 Foreground="#333942"/>
     </StackPanel>
    </Grid>
    <StackPanel Grid.Row="1" Orientation="Horizontal"
                HorizontalAlignment="Right" VerticalAlignment="Center">
     <Button x:Name="Pause" Content="Pause" Width="67" Height="29"
             FontSize="12" BorderBrush="#DDE1E7" BorderThickness="1"
             Background="#F5F6F9" Foreground="#414957"
             Cursor="Hand" Margin="0,0,7,0"/>
     <Button x:Name="Stop" Content="Stop" Width="60" Height="29"
             FontSize="12" BorderBrush="#EBCACB" BorderThickness="1"
             Background="#FFF4F3" Foreground="#AD4545" Cursor="Hand"/>
    </StackPanel>
   </Grid>
  </Grid>
 </Border>
</Window>
'@
$reader = New-Object System.Xml.XmlNodeReader($xaml)
$window = [Windows.Markup.XamlReader]::Load($reader)
$header = $window.FindName('Header')
$elapsed = $window.FindName('Elapsed')
$dot = $window.FindName('ActivityDot')
$details = $window.FindName('Details')
$expand = $window.FindName('Expand')
$pause = $window.FindName('Pause')
$stop = $window.FindName('Stop')
$steps = @('Step0','Step1','Step2','Step3') | ForEach-Object {$window.FindName($_)}
$bounds = [System.Windows.SystemParameters]::WorkArea
$window.Left = $bounds.Left + (($bounds.Width - $window.Width) / 2)
$window.Top = $bounds.Top + 20
$header.Add_MouseLeftButtonDown({ try {$window.DragMove()} catch {} })
$script:collapsed = $false
$script:status = $null
$expand.Add_Click({
 $script:collapsed = -not $script:collapsed
 $details.Visibility = if($script:collapsed){'Collapsed'}else{'Visible'}
 $window.Height = if($script:collapsed){70}else{213}
 $expand.Content = if($script:collapsed){'v'}else{'^'}
})
$pause.Add_Click({
 try {
  $mode = [System.IO.File]::ReadAllText($controlFile).Trim()
  if($mode -eq 'paused'){
   [System.IO.File]::WriteAllText($controlFile,'running')
  } elseif($mode -ne 'stopped') {
   [System.IO.File]::WriteAllText($controlFile,'paused')
  }
 } catch {}
})
$stop.Add_Click({
 try {[System.IO.File]::WriteAllText($controlFile,'stopped')}catch{}
 $window.Close()
})
$window.Add_Closing({
 try {[System.IO.File]::WriteAllText($controlFile,'stopped')}catch{}
})
$timer = New-Object Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(180)
$timer.Add_Tick({
 if(-not (Test-Path $controlFile)){
   $window.Close()
   return
 }
 try {
   $mode = [System.IO.File]::ReadAllText($controlFile).Trim()
 } catch { $mode='running' }
 if($mode -eq 'stopped'){
   $window.Close()
   return
 }
 $pause.Content = if($mode -eq 'paused'){'Resume'}else{'Pause'}
 $dot.Fill = if($mode -eq 'paused'){'#EBA850'}else{'#46A4F4'}
 if(Test-Path $stateFile){
  try {
   $script:status = [System.IO.File]::ReadAllText($stateFile) | ConvertFrom-Json
  } catch {}
 }
 if($null -ne $script:status) {
  $sec = [int][Math]::Max(0,((Get-Date) - [DateTimeOffset]::FromUnixTimeMilliseconds([long]$script:status.startedAt).LocalDateTime).TotalSeconds)
  $elapsed.Text = if($mode -eq 'paused'){'Paused after '+$sec+' seconds'}else{'Operated for '+$sec+' seconds'}
  $entries = @($script:status.steps)
  if($entries.Count -eq 0){$entries=@([PSCustomObject]@{label='Initializing'})}
  for($i=0; $i -lt $steps.Count; $i++){
   if($i -lt $entries.Count){
    $steps[$i].Text=[string]$entries[$i].label
    $steps[$i].Visibility='Visible'
    $steps[$i].Foreground= if($entries[$i].outcome -eq 'failed'){'#B14C4C'}else{'#333942'}
   }else{
    $steps[$i].Visibility='Collapsed'
   }
  }
 }
})
$timer.Start()
try {$null=$window.ShowDialog()} finally {$timer.Stop()}
