//! Shared-memory wasm futexes. Called only inside the browser's dedicated session/pool Workers.
use core::arch::wasm32::{memory_atomic_notify, memory_atomic_wait32, memory_size};
use core::sync::atomic::AtomicU32;

#[cfg(not(target_feature = "atomics"))]
compile_error!("atomic-wait's wasm backend requires shared-memory atomics");

pub fn wait(atomic: &AtomicU32, value: u32) {
    // SAFETY: AtomicU32 supplies a live, aligned four-byte address in shared wasm memory.
    // Signed casts preserve the expected bit pattern. -1 is the specified infinite timeout.
    unsafe {
        memory_atomic_wait32(atomic.as_ptr().cast::<i32>(), value as i32, -1);
    }
}

fn notify(atomic: *const AtomicU32, count: u32) {
    let address = atomic as usize;
    // The upstream safe API permits null/dangling pointers. Never dereference them, and
    // reject addresses that would trap the wasm instruction. Linear memory cannot shrink.
    if address == 0 || address % 4 != 0 || address as u64 + 4 > memory_size::<0>() as u64 * 65536 {
        return;
    }
    // SAFETY: notification does not load/store the addressed bytes. The checks above ensure
    // alignment and wasm-memory bounds; a freed but still in-bounds address is permitted.
    unsafe {
        memory_atomic_notify(atomic.cast_mut().cast::<i32>(), count);
    }
}

pub fn wake_one(atomic: *const AtomicU32) {
    notify(atomic, 1);
}
pub fn wake_all(atomic: *const AtomicU32) {
    notify(atomic, u32::MAX);
}
