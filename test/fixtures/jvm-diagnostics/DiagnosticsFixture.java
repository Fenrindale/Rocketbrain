import java.util.concurrent.CountDownLatch;
import java.util.concurrent.locks.LockSupport;

final class DiagnosticsFixture {
    private static final CountDownLatch READY = new CountDownLatch(4);
    private static final CountDownLatch LOCKED = new CountDownLatch(2);
    private static final Object LEFT = new Object();
    private static final Object RIGHT = new Object();
    private static volatile Allocation[] retained = new Allocation[512];
    private static volatile long checksum;

    private record Allocation(byte[] bytes, long marker) {}

    static void allocateAndCompute() {
        long x = 5233L;
        READY.countDown();
        while (!Thread.currentThread().isInterrupted()) {
            for (int i = 0; i < 8000; i++) {
                x ^= x << 13;
                x ^= x >>> 7;
                x ^= x << 17;
                int slot = i & 511;
                retained[slot] = new Allocation(new byte[512 + (slot & 31)], x);
            }
            checksum = x;
            LockSupport.parkNanos(500_000);
        }
    }

    static void lock(Object own, Object peer) {
        synchronized (own) {
            LOCKED.countDown();
            READY.countDown();
            try {
                LOCKED.await();
                synchronized (peer) {
                    checksum++;
                }
            } catch (InterruptedException stop) {
                Thread.currentThread().interrupt();
            }
        }
    }

    public static void main(String[] args) throws Exception {
        Thread.ofPlatform().daemon().name("rb-diagnostics-cpu").start(DiagnosticsFixture::allocateAndCompute);
        Thread.ofPlatform().daemon().name("rb-diagnostics-lock-left").start(() -> lock(LEFT, RIGHT));
        Thread.ofPlatform().daemon().name("rb-diagnostics-lock-right").start(() -> lock(RIGHT, LEFT));
        Thread.ofVirtual().name("rb-diagnostics-virtual").start(() -> {
            READY.countDown();
            LockSupport.park();
        });
        READY.await();
        System.out.println("READY");
        System.in.read();
    }
}
