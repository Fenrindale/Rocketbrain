package fixture.boot.extensionv21;

import org.springframework.context.annotation.ImportSelector;
import org.springframework.core.type.AnnotationMetadata;

public final class V21LiteralSelector implements ImportSelector {
    @Override
    public String[] selectImports(AnnotationMetadata metadata) {
        return new String[] { "fixture.boot.extensionv21.V21ImportedConfiguration" };
    }
}
