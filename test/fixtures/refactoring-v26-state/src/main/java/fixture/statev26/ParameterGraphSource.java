package fixture.statev26;

public final class ParameterGraphSource {
    private final GraphBranch root;
    private final GraphBranch alias;

    public ParameterGraphSource() {
        this.root = new GraphBranch(new GraphLeaf(new GraphTarget(9), new GraphTarget(6)),
                new GraphLeaf(new GraphTarget(7), new GraphTarget(8)));
        this.alias = this.root;
    }

    public int measureGraph(GraphTarget target, GraphTarget left, GraphTarget right, int delta) {
        return (left != right ? 1000 : 0)
                + target.advance(delta) * 100 + left.advance(1) * 10 + right.advance(2);
    }

    public int run(int delta) {
        return measureGraph(new GraphTarget(2), this.root.left().head(), this.alias.left().head(), delta);
    }
}
