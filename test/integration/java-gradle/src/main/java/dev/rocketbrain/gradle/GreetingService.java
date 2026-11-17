package dev.rocketbrain.gradle;

import java.util.List;

public class GreetingService {
    public String greet(String name) {
        return "Hello, " + name;
    }

    public List<String> names() {
        return List.of("Rocketbrain", "Gradle");
    }
}
