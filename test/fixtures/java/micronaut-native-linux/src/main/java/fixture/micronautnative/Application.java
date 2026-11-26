package fixture.micronautnative;

import io.micronaut.context.env.Environment;
import io.micronaut.runtime.Micronaut;

public final class Application {
    public static void main(String[] args) {
        new FixtureServer().mainClass(Application.class).args(args).start();
    }

    private static final class FixtureServer extends Micronaut {
        @Override
        protected void handleStartupException(Environment environment, Throwable failure) {
            failure.printStackTrace(System.err);
            super.handleStartupException(environment, failure);
        }
    }
}
