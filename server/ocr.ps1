# Reconnaissance de texte (OCR) intégrée à Windows, sans dépendance.
# Usage : powershell.exe -NoProfile -ExecutionPolicy Bypass -File ocr.ps1 <image.png> [langue]
# Sortie : JSON { langue, lignes: [{ texte, x, y, largeur, hauteur }] } en pixels de l'image.
param([Parameter(Mandatory = $true)][string]$Chemin, [string]$Langue = "")

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]

# Les API WinRT sont asynchrones : on attend chaque opération via AsTask.
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
function Attendre($operation, $type) {
  $tache = $asTask.MakeGenericMethod($type).Invoke($null, @($operation))
  $null = $tache.Wait(-1)
  $tache.Result
}

$fichier = Attendre ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Chemin)) ([Windows.Storage.StorageFile])
$flux = Attendre ($fichier.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decodeur = Attendre ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($flux)) ([Windows.Graphics.Imaging.BitmapDecoder])
$image = Attendre ($decodeur.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

$moteur = if ($Langue) {
  [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new($Langue))
} else {
  [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
}
if (-not $moteur) { throw "Aucun moteur OCR pour la langue demandée." }

$resultat = Attendre ($moteur.RecognizeAsync($image)) ([Windows.Media.Ocr.OcrResult])
$lignes = foreach ($ligne in $resultat.Lines) {
  $mots = $ligne.Words
  $gauche = ($mots | ForEach-Object { $_.BoundingRect.X } | Measure-Object -Minimum).Minimum
  $haut = ($mots | ForEach-Object { $_.BoundingRect.Y } | Measure-Object -Minimum).Minimum
  $droite = ($mots | ForEach-Object { $_.BoundingRect.X + $_.BoundingRect.Width } | Measure-Object -Maximum).Maximum
  $bas = ($mots | ForEach-Object { $_.BoundingRect.Y + $_.BoundingRect.Height } | Measure-Object -Maximum).Maximum
  [pscustomobject]@{ texte = $ligne.Text; x = $gauche; y = $haut; largeur = $droite - $gauche; hauteur = $bas - $haut }
}
$flux.Dispose()
[pscustomobject]@{ langue = $moteur.RecognizerLanguage.LanguageTag; lignes = @($lignes) } | ConvertTo-Json -Depth 4 -Compress
