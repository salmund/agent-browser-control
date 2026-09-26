# OCR des pages d'un PDF (pages scannées, sans texte) avec les API intégrées à Windows : Windows.Data.Pdf
# affiche la page, Windows.Media.Ocr la lit. Aucune dépendance.
# Usage : powershell.exe -NoProfile -ExecutionPolicy Bypass -File pdf-ocr.ps1 <fichier.pdf> <pages : 1,3,4> [langue]
# Sortie : JSON [{ page, texte }]
param([Parameter(Mandatory = $true)][string]$Chemin, [Parameter(Mandatory = $true)][string]$Pages, [string]$Langue = "")

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]

$methodes = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 }
$asTaskOperation = $methodes | Where-Object { $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
$asTaskAction = $methodes | Where-Object { $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' } | Select-Object -First 1
function Attendre($operation, $type) {
  $tache = $asTaskOperation.MakeGenericMethod($type).Invoke($null, @($operation))
  $null = $tache.Wait(-1)
  $tache.Result
}
function AttendreAction($action) { $null = $asTaskAction.Invoke($null, @($action)).Wait(-1) }

$fichier = Attendre ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Chemin)) ([Windows.Storage.StorageFile])
$pdf = Attendre ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($fichier)) ([Windows.Data.Pdf.PdfDocument])
$moteur = if ($Langue) {
  [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new($Langue))
} else {
  [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
}
if (-not $moteur) { throw "Aucun moteur OCR pour la langue demandée." }

$resultats = foreach ($numero in ($Pages -split "," | ForEach-Object { [int]$_ })) {
  if ($numero -lt 1 -or $numero -gt $pdf.PageCount) { continue }
  $page = $pdf.GetPage($numero - 1)
  # Rendu à ~2x : la reconnaissance est bien meilleure sur un texte plus grand (dans la limite du moteur).
  $options = [Windows.Data.Pdf.PdfPageRenderOptions]::new()
  $options.DestinationWidth = [uint32][Math]::Min($page.Size.Width * 2.5, [Windows.Media.Ocr.OcrEngine]::MaxImageDimension)
  $flux = [Windows.Storage.Streams.InMemoryRandomAccessStream]::new()
  AttendreAction ($page.RenderToStreamAsync($flux, $options))
  $decodeur = Attendre ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($flux)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $image = Attendre ($decodeur.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $ocr = Attendre ($moteur.RecognizeAsync($image)) ([Windows.Media.Ocr.OcrResult])
  [pscustomobject]@{ page = $numero; texte = (($ocr.Lines | ForEach-Object { $_.Text }) -join "`n") }
  $page.Dispose()
  $flux.Dispose()
}
ConvertTo-Json -InputObject @($resultats) -Depth 3 -Compress
