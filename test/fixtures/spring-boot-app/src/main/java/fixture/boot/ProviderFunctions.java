package fixture.boot;
import org.hibernate.boot.model.FunctionContributor;
import org.hibernate.boot.model.FunctionContributions;
import org.hibernate.query.sqm.produce.function.FunctionParameterType;
import org.hibernate.type.StandardBasicTypes;
public class ProviderFunctions implements FunctionContributor {
    @Override public void contributeFunctions(FunctionContributions context) {
        context.getFunctionRegistry().namedDescriptorBuilder("rb_upper", "upper")
            .setExactArgumentCount(1).setParameterTypes(FunctionParameterType.STRING)
            .setInvariantType(context.getTypeConfiguration().getBasicTypeRegistry().resolve(StandardBasicTypes.STRING)).register();
    }
}
