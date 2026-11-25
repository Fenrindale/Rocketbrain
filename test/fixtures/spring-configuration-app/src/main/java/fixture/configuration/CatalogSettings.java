package fixture.configuration;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties("fixture.catalog")
public class CatalogSettings {
    /** Display name read by the owned fixture. */
    private String displayName;
    /** Maximum rows returned by the JDBC check. */
    private int queryLimit;
    private int retries;
    private Duration timeout;
    private List<Integer> thresholds;
    private Map<String,String> labels;

    public String getDisplayName() { return displayName; }
    public void setDisplayName(String displayName) { this.displayName = displayName; }
    public int getQueryLimit() { return queryLimit; }
    public void setQueryLimit(int queryLimit) { this.queryLimit = queryLimit; }
    public int getRetries() { return retries; }
    public void setRetries(int retries) { this.retries = retries; }
    public Duration getTimeout() { return timeout; }
    public void setTimeout(Duration timeout) { this.timeout = timeout; }
    public List<Integer> getThresholds() { return thresholds; }
    public void setThresholds(List<Integer> thresholds) { this.thresholds = thresholds; }
    public Map<String,String> getLabels() { return labels; }
    public void setLabels(Map<String,String> labels) { this.labels = labels; }
}
