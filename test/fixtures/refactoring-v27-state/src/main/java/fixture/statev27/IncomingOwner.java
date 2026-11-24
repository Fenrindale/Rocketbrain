package fixture.statev27;

public final class IncomingOwner {
    public int measureBorrowed(RefTarget target, RefTarget left, RefTarget right, int amount) {
        return left == null ? target.advance(amount) * 1000 + 2
                : (left == right ? 1000 : 2000) + target.advance(amount) * 100
                    + left.advance(1) * 10 + (right == null ? 0 : right.advance(2));
    }

    public int runBorrowed(RefTarget incoming, RefTarget other, int amount) {
        return measureBorrowed(new RefTarget(3), incoming, other, amount);
    }

    public int runAliased(RefTarget incoming, int amount) {
        return measureBorrowed(new RefTarget(3), incoming, incoming, amount);
    }
}
