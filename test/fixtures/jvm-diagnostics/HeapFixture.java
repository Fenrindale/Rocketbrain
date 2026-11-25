import java.lang.ref.WeakReference;

class HeapFixture {
    static final class Payload {
        final byte[] bytes;
        Payload(int size) { bytes = new byte[size]; }
    }
    static class Ancestor {
        final Payload owned;
        Ancestor(Payload owned) { this.owned = owned; }
    }
    static final class Owner extends Ancestor {
        final Payload shared;
        final Object[] chain;
        Owner(Payload shared) {
            super(new Payload(40000));
            this.shared = shared;
            this.chain = new Object[] { new Payload(18000), this };
        }
    }
    static final Payload SHARED = new Payload(30000);
    static final Owner KEEP = new Owner(SHARED);
    static final WeakReference<Payload> WEAK = new WeakReference<>(new Payload(12000));

    public static void main(String[] args) throws Exception {
        System.out.println("HEAP_READY");
        System.in.read();
    }
}
