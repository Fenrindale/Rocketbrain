package fixture.dynamicv24.extensions;

import org.springframework.context.annotation.ImportSelector;
import org.springframework.core.type.AnnotationMetadata;

public final class V24FiniteSelector implements ImportSelector {
    @Override
    public String[] selectImports(AnnotationMetadata metadata) {
        final String prefix = "fixture.dynamicv24.selected.";
        final String annotation = "fixture.dynamicv24.annotations.V24Choice";
        final boolean blue = metadata.isAnnotated(annotation)
            && "blue".equals(metadata.getAnnotationAttributes(annotation).get("route"));
        return blue ? new String[] {prefix + "V24BlueSelected"}
            : new String[] {prefix + "V24GreenSelected"};
    }
}
