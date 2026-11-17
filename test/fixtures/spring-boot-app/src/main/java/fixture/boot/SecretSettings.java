package fixture.boot;
import org.springframework.boot.context.properties.ConfigurationProperties;
@ConfigurationProperties(prefix="fixture.credentials")
public class SecretSettings {
    private String password;
    private String apiKey;
    public String getPassword() { return password; }
    public void setPassword(String value) { password=value; }
    public String getApiKey() { return apiKey; }
    public void setApiKey(String value) { apiKey=value; }
}
