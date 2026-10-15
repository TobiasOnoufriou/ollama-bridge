# Show the modern Windows folder picker and print the chosen path (nothing if cancelled).
# Used by the web UI's "Browse..." button. Run with: powershell -NoProfile -STA -File pick-folder.ps1
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class FolderPicker {
    [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialogRCW { }

    // IFileOpenDialog vtable order; methods we never call keep placeholder signatures.
    [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IFileOpenDialog {
        [PreserveSig] int Show(IntPtr hwnd);
        void SetFileTypes(); void SetFileTypeIndex(); void GetFileTypeIndex(); void Advise(); void Unadvise();
        void SetOptions(uint fos); void GetOptions(out uint fos);
        void SetDefaultFolder(); void SetFolder(); void GetFolder(); void GetCurrentSelection();
        void SetFileName(); void GetFileName();
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        void SetFileNameLabel();
        void GetResult(out IShellItem item);
    }

    [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellItem {
        void BindToHandler(); void GetParent();
        void GetDisplayName(uint sigdn, [MarshalAs(UnmanagedType.LPWStr)] out string name);
    }

    public static string Pick(IntPtr owner) {
        var dlg = (IFileOpenDialog)new FileOpenDialogRCW();
        uint opts; dlg.GetOptions(out opts);
        dlg.SetOptions(opts | 0x20 | 0x40);  // FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM
        dlg.SetTitle("Choose a project folder");
        dlg.SetOkButtonLabel("Add project");
        if (dlg.Show(owner) != 0) return null;  // cancelled
        IShellItem item; dlg.GetResult(out item);
        string path; item.GetDisplayName(0x80058000, out path);  // SIGDN_FILESYSPATH
        return path;
    }
}
"@

# An invisible topmost owner window so the dialog appears in front of the browser.
$owner = New-Object System.Windows.Forms.Form -Property @{
    TopMost = $true; ShowInTaskbar = $false; Opacity = 0; StartPosition = 'CenterScreen'; Width = 1; Height = 1
}
$owner.Show()
$owner.Activate()
try {
    $picked = [FolderPicker]::Pick($owner.Handle)
    if ($picked) { [Console]::Out.Write($picked) }
} finally {
    $owner.Close()
}
