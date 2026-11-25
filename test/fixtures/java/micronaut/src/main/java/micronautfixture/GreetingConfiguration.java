package micronautfixture;

import io.micronaut.context.annotation.ConfigurationProperties;

@ConfigurationProperties("greeting")
public class GreetingConfiguration {
    private String message;
    private int repeatCount = 2;

    public String getMessage() { return message; }
    public void setMessage(String message) { this.message = message; }

    public int getRepeatCount() { return repeatCount; }
    public void setRepeatCount(int repeatCount) { this.repeatCount = repeatCount; }
}
