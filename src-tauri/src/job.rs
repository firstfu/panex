//! Windows only: each tab's shell runs inside its own Job Object, so closing the tab takes
//! down everything the shell started (claude, its MCP servers, programs opened with
//! `start`), not just the shell. Claude Code does not reliably reap its MCP servers on
//! Windows, and those have their own consoles, so they would outlive the pseudoconsole.
//! KILL_ON_JOB_CLOSE also covers panex crashing: the OS closes the handle and the job dies.

use std::os::windows::io::RawHandle;
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

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
            // BREAKAWAY_OK lets a program that asks for CREATE_BREAKAWAY_FROM_JOB leave.
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
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

    pub fn terminate(&self) {
        unsafe {
            TerminateJobObject(self.0, 1);
        }
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
