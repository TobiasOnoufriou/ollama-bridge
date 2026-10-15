# Launch Claude Code against the local Ollama model instead of Anthropic's API.
# Usage (from any project folder):  claude-local [-Model name] [any other claude args]
# The variables are set for this process only, so normal Claude sessions are unaffected.
# No param() block on purpose: PowerShell would swallow claude flags like -p as its own common parameters.

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js isn't installed. Install it with: winget install OpenJS.NodeJS.LTS"
    exit 1
}
# Defaults come from config.json (see install.mjs); environment variables override them.
$Config = node "$PSScriptRoot\config.mjs" | ConvertFrom-Json
$Model = if ($env:CLAUDE_LOCAL_MODEL) { $env:CLAUDE_LOCAL_MODEL } else { $Config.claudeLocalVariant }
# Context window the model was created with (see the generated models\*.Modelfile num_ctx).
$ContextTokens = if ($env:CLAUDE_LOCAL_CTX) { $env:CLAUDE_LOCAL_CTX } else { "$($Config.claudeLocalCtx)" }
$OllamaUrl = if ($env:OLLAMA_HOST_URL) { $env:OLLAMA_HOST_URL } else { $Config.ollamaUrl }

$Rest = @()
for ($i = 0; $i -lt $args.Count; $i++) {
    if ($args[$i] -eq "-Model" -and $i + 1 -lt $args.Count) { $Model = $args[++$i] }
    else { $Rest += $args[$i] }
}

if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    Write-Error "The Claude Code CLI isn't installed. Install it with: winget install Anthropic.ClaudeCode"
    exit 1
}

try { Invoke-RestMethod "$OllamaUrl/api/version" -TimeoutSec 3 | Out-Null }
catch { Write-Error "Ollama isn't running. Start the Ollama app (or run 'ollama serve') and try again."; exit 1 }

$env:ANTHROPIC_BASE_URL = $OllamaUrl
$env:ANTHROPIC_AUTH_TOKEN = "ollama"
$env:ANTHROPIC_API_KEY = ""
# Route the background/small-model calls to the same local model.
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL = $Model
$env:ANTHROPIC_DEFAULT_SONNET_MODEL = $Model
$env:ANTHROPIC_DEFAULT_OPUS_MODEL = $Model
$env:CLAUDE_CODE_MAX_CONTEXT_TOKENS = $ContextTokens
$env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1"

Write-Host "Claude Code -> local Ollama model '$Model' ($ContextTokens-token context)" -ForegroundColor Cyan
claude --model $Model @Rest
exit $LASTEXITCODE
