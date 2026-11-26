package mixed.rename.contract

fun checkContracts(value: String?) {
    Names.maybe()?.length
    Names.demand(value ?: "")
    Names.checked<String>(value ?: "")
    Names.items()[0]?.length
    Names.platform().length
    value?.trim()
}
