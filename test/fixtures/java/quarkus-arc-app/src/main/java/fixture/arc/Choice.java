package fixture.arc;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;
import jakarta.enterprise.util.AnnotationLiteral;
import jakarta.inject.Qualifier;

@Qualifier
@Retention(RetentionPolicy.RUNTIME)
@Target({ElementType.METHOD, ElementType.FIELD, ElementType.PARAMETER, ElementType.TYPE})
public @interface Choice {
    String value();
    final class Literal extends AnnotationLiteral<Choice> implements Choice {
        private final String label;
        public Literal(String label){this.label=label;}
        @Override public String value(){return label;}
    }
}
