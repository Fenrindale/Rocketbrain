package rocketbrain.signature;

import com.sun.source.tree.CompilationUnitTree;
import com.sun.source.tree.IdentifierTree;
import com.sun.source.tree.ImportTree;
import com.sun.source.util.TreePathScanner;
import com.sun.source.util.Trees;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import javax.lang.model.element.Element;
import javax.lang.model.element.ElementKind;
import javax.lang.model.element.ExecutableElement;
import javax.lang.model.element.Modifier;
import javax.lang.model.element.TypeElement;

/** Reports attributed uses of an explicitly named static method or field. */
final class StaticImportInspector {
    static Map<String, Object> inspect(CompilationUnitTree unit, Trees trees, int from, int to, String qualified) {
        var positions = trees.getSourcePositions();
        var matches = new ArrayList<Map<String, Object>>();
        String name = qualified.substring(qualified.lastIndexOf('.') + 1);
        String[] selected = { null };
        new TreePathScanner<Void, Void>() {
            @Override public Void visitImport(ImportTree tree, Void unused) { return null; }

            @Override public Void visitIdentifier(IdentifierTree tree, Void unused) {
                if (!tree.getName().contentEquals(name)) return super.visitIdentifier(tree, unused);
                Element element = trees.getElement(getCurrentPath());
                if (element != null && element.getModifiers().contains(Modifier.STATIC) &&
                    element.getEnclosingElement() instanceof TypeElement owner &&
                    List.of(ElementKind.FIELD, ElementKind.ENUM_CONSTANT, ElementKind.METHOD).contains(element.getKind())) {
                    long start = positions.getStartPosition(unit, tree), end = positions.getEndPosition(unit, tree);
                    String identity = owner.getQualifiedName() + "." + name;
                    String signature = element instanceof ExecutableElement method ? SignatureInspector.key(method) :
                        owner.getQualifiedName() + "#" + element.getSimpleName() + ":" + element.asType();
                    matches.add(SignatureInspector.object("start", start, "end", end, "member", identity,
                        "signature", signature, "kind", element.getKind() == ElementKind.METHOD ? "method" : "field"));
                    if (start == from && end == to) selected[0] = identity;
                }
                return super.visitIdentifier(tree, unused);
            }
        }.scan(unit, null);
        return SignatureInspector.object("target", selected[0], "bindings", matches);
    }

    private StaticImportInspector() {}
}
