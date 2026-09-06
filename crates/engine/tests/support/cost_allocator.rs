//! Per-thread live-allocation high-water mark. Mesh construction is outside the measured
//! interval, and parallel tests cannot contaminate the estimator's scratch measurement.
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

thread_local! {
    static LIVE: Cell<Option<(usize, usize)>> = const { Cell::new(None) };
}

fn record(removed: usize, added: usize) {
    let _ = LIVE.try_with(|live| {
        if let Some((current, peak)) = live.get() {
            let current = current - removed + added;
            live.set(Some((current, peak.max(current))));
        }
    });
}

struct Meter;
#[global_allocator]
static ALLOCATOR: Meter = Meter;

unsafe impl GlobalAlloc for Meter {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let p = unsafe { System.alloc(layout) };
        record(0, layout.size());
        p
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let p = unsafe { System.alloc_zeroed(layout) };
        record(0, layout.size());
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, layout: Layout) {
        record(layout.size(), 0);
        unsafe { System.dealloc(p, layout) };
    }
    unsafe fn realloc(&self, p: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        let p = unsafe { System.realloc(p, layout, size) };
        record(layout.size(), size);
        p
    }
}

pub fn measure<T>(f: impl FnOnce() -> T) -> (T, usize) {
    LIVE.with(|live| live.set(Some((0, 0))));
    let value = f();
    let (_, peak) = LIVE.with(|live| live.replace(None)).unwrap();
    (value, peak)
}
