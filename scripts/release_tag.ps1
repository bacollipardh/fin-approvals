param(
  [Parameter(Mandatory=$true)][string]$Tag
)

$dirty = git status --porcelain
if ($dirty) { throw "Working tree not clean" }

git tag $Tag
if ($LASTEXITCODE -ne 0) { throw "git tag failed" }

git push origin $Tag
if ($LASTEXITCODE -ne 0) { throw "git push failed" }

Write-Host "Pushed tag $Tag"
