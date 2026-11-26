package micronautgradlefixture;

import io.micronaut.context.annotation.ConfigurationProperties;

@ConfigurationProperties("fixture")
class GreetingConfiguration {
    private String message;
    public String getMessage(){return message;}
    public void setMessage(String message){this.message=message;}
}
