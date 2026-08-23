param(
  [Parameter(Mandatory = $true)]
  [string] $PromptBase64
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$prompt = [System.Text.Encoding]::UTF8.GetString(
  [Convert]::FromBase64String($PromptBase64)
)

$form = [System.Windows.Forms.Form]::new()
$form.Text = 'Gaia operator authorization'
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
$form.MinimizeBox = $false
$form.MaximizeBox = $false
$form.ClientSize = [System.Drawing.Size]::new(520, 155)
$form.TopMost = $true

$label = [System.Windows.Forms.Label]::new()
$label.AutoSize = $false
$label.Location = [System.Drawing.Point]::new(16, 16)
$label.Size = [System.Drawing.Size]::new(488, 42)
$label.Text = $prompt

$secret = [System.Windows.Forms.TextBox]::new()
$secret.Location = [System.Drawing.Point]::new(16, 64)
$secret.Size = [System.Drawing.Size]::new(488, 24)
$secret.UseSystemPasswordChar = $true

$ok = [System.Windows.Forms.Button]::new()
$ok.Location = [System.Drawing.Point]::new(336, 108)
$ok.Size = [System.Drawing.Size]::new(80, 30)
$ok.Text = 'OK'
$ok.DialogResult = [System.Windows.Forms.DialogResult]::OK

$cancel = [System.Windows.Forms.Button]::new()
$cancel.Location = [System.Drawing.Point]::new(424, 108)
$cancel.Size = [System.Drawing.Size]::new(80, 30)
$cancel.Text = 'Cancel'
$cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel

$form.Controls.AddRange(@($label, $secret, $ok, $cancel))
$form.AcceptButton = $ok
$form.CancelButton = $cancel
$form.Add_Shown({ $secret.Focus() })

try {
  if ($form.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
    exit 3
  }
  $encoded = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($secret.Text))
  [Console]::Out.Write($encoded)
} finally {
  $form.Dispose()
}
