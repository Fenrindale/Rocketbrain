package fixture.statev27;

public final class MutableOwner {
    private final RefTarget primary = new RefTarget(4);
    private final RefTarget backup = new RefTarget(9);
    private RefTarget active;

    public MutableOwner() {
        this.active = new RefTarget(2);
    }

    public int measureOwned(RefTarget left, RefTarget right, int delta) {
        return left == null ? primary.advance(delta) * 1000 + 1
                : (left == right ? 1000 : 2000) + primary.advance(delta) * 100
                    + left.advance(1) * 10 + (right == null ? 0 : right.advance(2));
    }

    public int runIncoming(RefTarget incoming, int delta) {
        this.active = incoming;
        return measureOwned(this.active, incoming, delta);
    }

    public int runCurrent(RefTarget opponent, int delta) {
        return measureOwned(this.active, opponent, delta);
    }

    public int runOwned(RefTarget opponent, int delta) {
        this.active = this.backup;
        return measureOwned(this.active, opponent, delta);
    }

    public int runNew(int delta) {
        this.active = this.backup;
        this.active = new RefTarget(7);
        return measureOwned(this.active, this.backup, delta);
    }

    public int runClear(int delta) {
        this.active = null;
        return measureOwned(this.active, this.backup, delta);
    }
}
