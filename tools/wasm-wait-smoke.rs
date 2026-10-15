//! CI-only raw shared-memory module, compiling the exact vendored backend rather than a copy.
#![no_std]
#![feature(stdarch_wasm_atomic_wait)]

use core::sync::atomic::{AtomicU32, Ordering};
#[path = "../vendor/atomic-wait/src/wasm32.rs"]
mod platform;

static CELL: AtomicU32 = AtomicU32::new(0);
#[panic_handler]
fn panic(_: &core::panic::PanicInfo<'_>) -> ! {
    loop {
        core::hint::spin_loop();
    }
}

#[no_mangle]
pub extern "C" fn address() -> u32 {
    CELL.as_ptr() as u32
}
#[no_mangle]
pub extern "C" fn store(value: u32) {
    CELL.store(value, Ordering::SeqCst);
}
#[no_mangle]
pub extern "C" fn wait(expected: u32) {
    platform::wait(&CELL, expected);
}
#[no_mangle]
pub extern "C" fn wake_one() {
    platform::wake_one(&CELL);
}
#[no_mangle]
pub extern "C" fn wake_all() {
    platform::wake_all(&CELL);
}
#[no_mangle]
pub extern "C" fn notify_invalid(address: u32) {
    platform::wake_one(address as *const AtomicU32);
    platform::wake_all(address as *const AtomicU32);
}
