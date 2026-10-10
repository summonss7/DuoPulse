$cs = @'
using System;
using System.Runtime.InteropServices;

public class WasapiCheck {
  [DllImport("ole32.dll")]
  static extern int CoCreateInstance(ref Guid clsid, IntPtr pUnkOuter, uint dwClsContext, ref Guid riid, out IntPtr ppv);

  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
  }

  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    int Activate(ref Guid iid, uint dwClsCtx, IntPtr activationParams, out IntPtr iface);
  }

  [Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioClient {
    int Initialize(int shareMode, int streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr audioSessionGuid);
    int GetBufferSize(out uint numBufferFrames);
    int GetStreamFormat(out IntPtr format);
    int GetCurrentPadding(out uint padding);
    int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closestMatch);
    int GetMixFormat(out IntPtr format);
  }

  [StructLayout(LayoutKind.Sequential, Pack = 2)]
  struct WAVEFORMATEXTENSIBLE {
    public short wFormatTag;
    public short nChannels;
    public int nSamplesPerSec;
    public int nAvgBytesPerSec;
    public short nBlockAlign;
    public short wBitsPerSample;
    public short cbSize;
    public short wValidBitsPerSample;
    public int dwChannelMask;
    public Guid subFormat;
  }

  public static string Check() {
    try {
      var enumClsid = new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E");
      var enumIid = new Guid("A95664D2-9614-4F35-A746-DE8DB63617E6");
      IntPtr pEnum;
      int hr = CoCreateInstance(ref enumClsid, IntPtr.Zero, 1, ref enumIid, out pEnum);
      if (hr != 0) return "CoCreateInstance failed: 0x" + hr.ToString("X8");
      var en = (IMMDeviceEnumerator)Marshal.GetObjectForIUnknown(pEnum);
      string result = "";
      for (int role = 0; role <= 2; role++) {
        IMMDevice dev;
        hr = en.GetDefaultAudioEndpoint(0, role, out dev);
        string roleName = role == 0 ? "console" : role == 1 ? "multimedia" : "communications";
        if (hr != 0) {
          result += roleName + ": no default device, hr=0x" + hr.ToString("X8") + "\n";
          continue;
        }
        var iidAc = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
        IntPtr acPtr;
        hr = dev.Activate(ref iidAc, 1, IntPtr.Zero, out acPtr);
        if (hr != 0) { result += roleName + ": Activate failed hr=0x" + hr.ToString("X8") + "\n"; continue; }
        var ac = (IAudioClient)Marshal.GetObjectForIUnknown(acPtr);
        IntPtr fmt;
        hr = ac.GetMixFormat(out fmt);
        if (hr != 0) { result += roleName + ": GetMixFormat failed hr=0x" + hr.ToString("X8") + "\n"; continue; }
        var wfx = (WAVEFORMATEXTENSIBLE)Marshal.PtrToStructure(fmt, typeof(WAVEFORMATEXTENSIBLE));
        result += roleName + ": channels=" + wfx.nChannels + ", rate=" + wfx.nSamplesPerSec + ", bits=" + wfx.wBitsPerSample + ", mask=0x" + wfx.dwChannelMask.ToString("X") + "\n";
        Marshal.FreeCoTaskMem(fmt);
      }
      return result;
    } catch (Exception e) {
      return "EXCEPTION: " + e.GetType().Name + ": " + e.Message;
    }
  }
}
'@
Add-Type -TypeDefinition $cs
[WasapiCheck]::Check()
