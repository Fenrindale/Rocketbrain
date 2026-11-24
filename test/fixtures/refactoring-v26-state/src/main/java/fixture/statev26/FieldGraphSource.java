package fixture.statev26;

public final class FieldGraphSource {
    private final GraphTarget primary = new GraphTarget(2);
    private final GraphLeaf pair = new GraphLeaf(primary, new GraphTarget(10));
    private final GraphBranch branch = new GraphBranch(pair, new GraphLeaf(primary, new GraphTarget(10)));
    private final GraphGrove grove = new GraphGrove(new GraphCrown(branch));
    private final GraphTarget rightAlias;
    private final int bias;

    public FieldGraphSource() {
        this(10);
    }

    public FieldGraphSource(int bias) {
        this.rightAlias = this.grove.crown().echo().right().head();
        this.bias = bias;
    }

    public int routeGraph(GraphTarget left, GraphTarget right, int delta, int bias) {
        return (left == right ? 1000 : 2000)
                + primary.advance(delta) * 100 + left.advance(1) * 10 + right.advance(2) + bias;
    }

    public int runShared(int delta) {
        return routeGraph(this.grove.crown().branch().left().head(),
                this.grove.crown().echo().right().head(), delta, this.bias);
    }

    public int runDistinct(int delta) {
        return routeGraph(this.rightAlias, this.pair.tail(), delta, this.bias);
    }
}
