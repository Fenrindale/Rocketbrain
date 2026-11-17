package dev.rocketbrain.gradle;

public class Application {
    public static void main(String[] args) {
        GreetingService service = new GreetingService();
        System.out.println(service.greet("independent build"));
    }
}
