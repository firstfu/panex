//! Windows only: each tab's shell runs inside its own Job Object, so closing the tab takes
//! down everything the shell started (claude, its MCP servers, programs opened with
//! `start`), not just the shell. Claude Code does not reliably reap its MCP servers on
//! Windows, and those have their own consoles, so they would outlive the pseudoconsole.
//! KILL_ON_JOB_CLOSE also covers panex crashing: the OS closes the handle and the job dies.

use std::collections::HashMap;
use std::os::windows::io::RawHandle;
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicProcessIdList, JobObjectExtendedLimitInformation,
    QueryInformationJobObject, SetInformationJobObject, TerminateJobObject, JOBOBJECT_BASIC_PROCESS_ID_LIST,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS_EX};
use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

pub struct Job(HANDLE);

// The handle is only used for kernel calls that are safe from any thread.
unsafe impl Send for Job {}
unsafe impl Sync for Job {}

impl Job {
    /// Puts `process` in a new job. Processes it spawned before this call stay outside.
    pub fn assign(process: RawHandle) -> Result<Job, String> {
        unsafe {
            let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if h.is_null() {
                return Err(format!("CreateJobObject: {}", std::io::Error::last_os_error()));
            }
            let job = Job(h);
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            // No BREAKAWAY_OK: with it, Git Bash (MSYS) starts programs outside the job (a Claude
            // background task's `sleep`, for one), and they outlive the tab.
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                h,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                return Err(format!("SetInformationJobObject: {}", std::io::Error::last_os_error()));
            }
            if AssignProcessToJobObject(h, process as HANDLE) == 0 {
                return Err(format!("AssignProcessToJobObject: {}", std::io::Error::last_os_error()));
            }
            Ok(job)
        }
    }

    /// Sum of the private memory of every process in the job, and how many there are.
    pub fn usage(&self) -> (u64, u32) {
        let mut bytes = 0u64;
        let pids = self.pids();
        for &pid in &pids {
            unsafe {
                let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
                if h.is_null() {
                    continue;
                }
                let mut m: PROCESS_MEMORY_COUNTERS_EX = std::mem::zeroed();
                m.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
                if K32GetProcessMemoryInfo(h, &mut m as *mut _ as *mut _, m.cb) != 0 {
                    bytes += m.PrivateUsage as u64;
                }
                CloseHandle(h);
            }
        }
        (bytes, pids.len() as u32)
    }

    fn pids(&self) -> Vec<u32> {
        // The list is a two-u32 header followed by one usize per process; grow until it fits.
        let mut cap = 256usize;
        loop {
            let mut buf = vec![0usize; 1 + cap];
            let ok = unsafe {
                QueryInformationJobObject(
                    self.0,
                    JobObjectBasicProcessIdList,
                    buf.as_mut_ptr() as *mut _,
                    (buf.len() * std::mem::size_of::<usize>()) as u32,
                    std::ptr::null_mut(),
                )
            };
            let list = unsafe { &*(buf.as_ptr() as *const JOBOBJECT_BASIC_PROCESS_ID_LIST) };
            if ok != 0 && list.NumberOfAssignedProcesses <= list.NumberOfProcessIdsInList {
                let n = list.NumberOfProcessIdsInList as usize;
                return buf[1..1 + n].iter().map(|&p| p as u32).collect();
            }
            if ok == 0 && std::io::Error::last_os_error().raw_os_error() != Some(234) {
                return Vec::new(); // anything but ERROR_MORE_DATA
            }
            cap = (list.NumberOfAssignedProcesses as usize).max(cap) * 2;
        }
    }

    /// Whether ending the job loses nothing but a Claude Code that `claude --resume` brings
    /// back (see `agent_rule::only_agent_in`). `shell` is the pid of the tab's shell.
    pub fn only_agent(&self, shell: u32) -> bool {
        crate::agent_rule::only_agent_in(&self.pids(), &snapshot(), shell, &crate::agent_rule::WINDOWS)
    }

    pub fn terminate(&self) {
        unsafe {
            TerminateJobObject(self.0, 1);
        }
    }
}

/// Every process on the machine: pid → (parent pid, lower-case exe name).
fn snapshot() -> HashMap<u32, (u32, String)> {
    let mut map = HashMap::new();
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return map;
        }
        let mut e: PROCESSENTRY32W = std::mem::zeroed();
        e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut ok = Process32FirstW(snap, &mut e);
        while ok != 0 {
            let len = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len());
            let exe = String::from_utf16_lossy(&e.szExeFile[..len]).to_lowercase();
            map.insert(e.th32ProcessID, (e.th32ParentProcessID, exe));
            ok = Process32NextW(snap, &mut e);
        }
        CloseHandle(snap);
    }
    map
}

impl Drop for Job {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
