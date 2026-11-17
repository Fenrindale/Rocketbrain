package fixture.boot;
/** Small deterministic application rule with covered and uncovered branches. */
public class RiskPolicy {
    public String category(int amount) {
        if (amount < 0) return "invalid";
        if (amount >= 100) return "review";
        return "normal";
    }
    public String unusedRule() { return "uncovered"; }
}
