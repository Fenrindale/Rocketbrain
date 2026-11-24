package fixture.conditionsv27.conditions;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;
import org.springframework.boot.autoconfigure.condition.ConditionalOnExpression;
import org.springframework.context.annotation.Profile;

@Retention(RetentionPolicy.RUNTIME)
@Target({ElementType.TYPE, ElementType.METHOD})
@Profile("rocket-blue")
@ConditionalOnExpression("#{(2 == 2 && 'a' != 'b') ? (true ? true : false) : false}")
public @interface FixedChoice {}
