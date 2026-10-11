using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

// Only emits a full-screen boolean. No window titles, text, screenshots or keys.
class ForegroundObserver {
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct MonitorInfo { public int Size; public Rect Monitor, Work; public uint Flags; }
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out Rect r);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
    [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr h, ref MonitorInfo info);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder name, int max);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    static bool Fullscreen(int parent) {
        IntPtr window = GetForegroundWindow(); uint pid;
        if (window == IntPtr.Zero || IsIconic(window)) return false;
        GetWindowThreadProcessId(window, out pid); if (pid == parent) return false;
        StringBuilder name = new StringBuilder(128); GetClassName(window, name, name.Capacity);
        if (name.ToString() == "Progman" || name.ToString() == "WorkerW" || name.ToString() == "Shell_TrayWnd") return false;
        Rect rect; MonitorInfo monitor = new MonitorInfo(); monitor.Size = Marshal.SizeOf(monitor);
        if (!GetWindowRect(window, out rect) || !GetMonitorInfo(MonitorFromWindow(window, 2), ref monitor)) return false;
        return rect.Left <= monitor.Monitor.Left + 2 && rect.Top <= monitor.Monitor.Top + 2 &&
            rect.Right >= monitor.Monitor.Right - 2 && rect.Bottom >= monitor.Monitor.Bottom - 2;
    }
    static int Main(string[] args) {
        int parent; if (args.Length != 1 || !Int32.TryParse(args[0], out parent)) return 2;
        SetProcessDPIAware();
        try {
            using (Process owner = Process.GetProcessById(parent)) {
                bool? previous = null;
                while (!owner.HasExited) {
                    bool value = Fullscreen(parent);
                    if (value != previous) { Console.WriteLine(value ? "{\"fullscreen\":true}" : "{\"fullscreen\":false}"); Console.Out.Flush(); previous = value; }
                    Thread.Sleep(1200);
                }
            }
        } catch { return 0; }
        return 0;
    }
}
