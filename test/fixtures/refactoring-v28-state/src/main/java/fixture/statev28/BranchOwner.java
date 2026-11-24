package fixture.statev28;

public final class BranchOwner {
    private final RefTarget receiver = new RefTarget(4);
    private final RefTarget fallback = new RefTarget(9);
    private RefTarget active;

    public BranchOwner() {
        this.active = new RefTarget(2);
    }

    public int measure(RefTarget observed, RefTarget other, int step) {
        return observed == null ? receiver.advance(step) * 100
                : receiver.advance(step) * 100 + observed.advance(1) * 10 + (observed == other ? 1 : 0);
    }

    public int choose(boolean useIncoming, RefTarget incoming, int step) {
        if (useIncoming) {
            this.active = incoming;
        } else {
            this.active = this.fallback;
        }
        return measure(this.active, incoming, step);
    }

    public int reset(boolean keep, RefTarget incoming, int step) {
        if (!keep) {
            this.active = null;
        }
        return measure(this.active, incoming, step);
    }

    public int current(RefTarget incoming, int step) {
        return measure(this.active, incoming, step);
    }
}
