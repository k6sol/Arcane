using System;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

namespace Arcane.Workers {
    // Fixed read-only PID query. No commands, paths, privileges or method names from callers.
    internal static class WorkerIdentity {
        [DllImport("kernel32.dll", SetLastError=true, ExactSpelling=true)]
        private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll", SetLastError=true, ExactSpelling=true)]
        private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError=true, ExactSpelling=true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetProcessTimes(IntPtr handle, out long created, out long exited, out long kernel, out long user);
        [DllImport("kernel32.dll", SetLastError=true, ExactSpelling=true, CharSet=CharSet.Unicode)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool QueryFullProcessImageNameW(IntPtr handle, uint flags, StringBuilder path, ref uint length);
        [DllImport("kernel32.dll", SetLastError=true, ExactSpelling=true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CloseHandle(IntPtr handle);

        private static string Quote(string value) {
            var result = new StringBuilder("\"");
            foreach (char c in value) {
                if(c=='\"')result.Append("\\\"");
                else if(c=='\\')result.Append("\\\\");
                else if(c<32 || char.IsSurrogate(c))result.Append("\\u").Append(((int)c).ToString("x4",CultureInfo.InvariantCulture));
                else result.Append(c);
            }
            return result.Append('"').ToString();
        }
        private static int Main(string[] args) {
            try {
                if(args.Length!=0)return 3;
                string raw=Environment.GetEnvironmentVariable("ARCANE_WORKER_PID");
                uint pid;
                if(string.IsNullOrEmpty(raw)||raw.Length>10||raw[0]=='0')return 3;
                foreach(char c in raw)if(c<'0'||c>'9')return 3;
                if(!uint.TryParse(raw,NumberStyles.None,CultureInfo.InvariantCulture,out pid)||pid==0)return 3;
                string output=null;
                bool failed=false;
                IntPtr handle=OpenProcess(0x101000,false,pid);
                int error=Marshal.GetLastWin32Error();
                if(handle==IntPtr.Zero) {
                    if(error!=87)return 4;
                    output="{\"v\":2,\"found\":false}";
                } else {
                    try {
                        uint before=WaitForSingleObject(handle,0);
                        if(before==0)output="{\"v\":2,\"found\":false}";
                        else if(before!=258)failed=true;
                        else {
                            long created,exited,kernel,user;
                            bool times=GetProcessTimes(handle,out created,out exited,out kernel,out user);
                            var path=new StringBuilder(4096);uint length=4096;
                            bool image=QueryFullProcessImageNameW(handle,0,path,ref length)&&length>0&&length<4096;
                            uint after=WaitForSingleObject(handle,0);
                            if(after==0)output="{\"v\":2,\"found\":false}";
                            else if(after!=258||!times||!image)failed=true;
                            else output="{\"v\":2,\"found\":true,\"pid\":"+pid.ToString(CultureInfo.InvariantCulture)+",\"created\":"+Quote(DateTime.FromFileTimeUtc(created).ToString("o",CultureInfo.InvariantCulture))+",\"executable\":"+Quote(path.ToString(0,(int)length))+"}";
                        }
                    } finally { if(!CloseHandle(handle))failed=true; }
                }
                if(failed||output==null||Encoding.UTF8.GetByteCount(output+"\n")>4096)return 4;
                Console.OutputEncoding=new UTF8Encoding(false);
                Console.Write(output+"\n");
                return 0;
            } catch { return 4; }
        }
    }
}
