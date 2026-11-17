package fixtures.valid;
import org.springframework.stereotype.Component;
import org.springframework.boot.context.properties.ConfigurationProperties;
@Component
@ConfigurationProperties(prefix = "app")
public class Settings {
    private String person;
    public String getPerson() { return person; }
    public void setPerson(String person) { this.person = person; }
}
